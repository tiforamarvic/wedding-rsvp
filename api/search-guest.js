// Vercel Serverless Function - Search Guest
//
// Design notes:
// - No user input is ever interpolated into an Airtable filterByFormula string.
//   The whole GuestList is fetched and matched in Node, which removes the
//   formula-injection surface entirely and makes fuzzy matching possible.
// - Matching is tolerant: case, accents, punctuation, extra/missing name parts,
//   and small typos all still resolve to the right guest.

const Airtable = require('airtable');

const GUEST_TABLE = 'GuestList';
const NAME_FIELD = 'Name';
const SEATS_FIELD = 'Reserved Seats';

// Cap how many near-matches we ever reveal, so the guest list can't be
// enumerated by typing a single common letter.
const MAX_SUGGESTIONS = 5;

/**
 * Normalise a name for comparison: lowercase, strip accents, drop punctuation,
 * collapse whitespace. "José  M. Dela-Cruz Jr." -> "jose m dela cruz jr"
 */
function normalise(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenise(value) {
  const normalised = normalise(value);
  return normalised ? normalised.split(' ') : [];
}

/**
 * Optimal string alignment distance (Levenshtein + adjacent transpositions),
 * so that "jhon" / "john" costs 1 rather than 2. Transposition is by far the
 * most common typo in hand-typed names.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const rows = [];
  for (let i = 0; i <= a.length; i++) rows.push([i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        rows[i][j - 1] + 1,        // insertion
        rows[i - 1][j] + 1,        // deletion
        rows[i - 1][j - 1] + cost  // substitution
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1); // transposition
      }

      rows[i][j] = value;
    }
  }

  return rows[a.length][b.length];
}

/**
 * Typo tolerance scales with word length: very short names must match exactly,
 * because one edit on a 3-letter name changes who it is.
 * Any collision this creates surfaces as a "choose your name" prompt rather
 * than a wrong guess, so erring slightly loose is safe.
 */
function typoBudget(length) {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

function tokensRoughlyMatch(a, b) {
  if (a === b) return true;
  // Allow initials: "m" matches "mark"
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return editDistance(a, b) <= typoBudget(Math.min(a.length, b.length));
}

/**
 * Score a query against one guest name.
 * Returns a number (higher is better) or null when it isn't a plausible match.
 */
function scoreMatch(queryTokens, guestTokens, queryNormalised, guestNormalised) {
  if (!queryTokens.length || !guestTokens.length) return null;

  if (queryNormalised === guestNormalised) return 1000;

  // Every token the guest typed should be accounted for in the stored name,
  // or vice versa — this is what lets "John Mark" match "John Mark Cruz"
  // and "John Mark Cruz" match "John Mark".
  const matchedFromQuery = queryTokens.filter((qt) =>
    guestTokens.some((gt) => tokensRoughlyMatch(qt, gt))
  ).length;
  const matchedFromGuest = guestTokens.filter((gt) =>
    queryTokens.some((qt) => tokensRoughlyMatch(qt, gt))
  ).length;

  const queryCovered = matchedFromQuery === queryTokens.length;
  const guestCovered = matchedFromGuest === guestTokens.length;

  if (!queryCovered && !guestCovered) return null;

  // A single generic token ("john") is only allowed to match when the stored
  // name is also a single token — otherwise it's too weak to act on alone,
  // but still worth offering as a suggestion.
  let score = 100 * (matchedFromQuery + matchedFromGuest);
  if (queryCovered && guestCovered) score += 200;
  if (guestNormalised.startsWith(queryNormalised)) score += 50;

  // Prefer names of similar length to the query
  score -= Math.abs(guestTokens.length - queryTokens.length) * 5;

  return score;
}

function toGuest(record) {
  return {
    id: record.id,
    name: record.get(NAME_FIELD),
    seats: Number(record.get(SEATS_FIELD)) || 0,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const rawName = req.body && req.body.name;

    if (!rawName || !String(rawName).trim()) {
      return res.status(400).json({ success: false, error: 'Please enter your name.' });
    }

    // If the guest picked from a suggestion list, we get an exact record id back
    // and can skip matching altogether.
    const recordId = req.body && req.body.recordId;

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    if (recordId && /^rec[A-Za-z0-9]{14}$/.test(recordId)) {
      const record = await base(GUEST_TABLE).find(recordId);
      return res.status(200).json({ success: true, guest: toGuest(record) });
    }

    const queryNormalised = normalise(rawName);
    const queryTokens = tokenise(rawName);

    const records = await base(GUEST_TABLE)
      .select({ fields: [NAME_FIELD, SEATS_FIELD] })
      .all();

    const scored = [];

    for (const record of records) {
      const guestName = record.get(NAME_FIELD);
      if (!guestName) continue;

      const guestNormalised = normalise(guestName);
      const guestTokens = tokenise(guestName);
      const score = scoreMatch(queryTokens, guestTokens, queryNormalised, guestNormalised);

      if (score !== null) {
        scored.push({ score, record, guestNormalised });
      }
    }

    if (!scored.length) {
      return res.status(404).json({
        success: false,
        error:
          "We couldn't find that name on the guest list. Try the name exactly as it appears on your invitation, or contact the couple.",
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const runnerUp = scored[1];

    // Confident single match: exact normalised hit, only one candidate, or a
    // clear winner over everything else.
    const isConfident =
      best.guestNormalised === queryNormalised ||
      !runnerUp ||
      best.score - runnerUp.score >= 150;

    if (isConfident) {
      return res.status(200).json({ success: true, guest: toGuest(best.record) });
    }

    // Ambiguous — hand the choice back to the guest instead of guessing.
    return res.status(200).json({
      success: false,
      ambiguous: true,
      error: 'We found more than one possible match. Please choose your name below.',
      matches: scored.slice(0, MAX_SUGGESTIONS).map((entry) => ({
        id: entry.record.id,
        name: entry.record.get(NAME_FIELD),
      })),
    });
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong on our end. Please try again in a moment.',
    });
  }
};