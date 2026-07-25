// Vercel Serverless Function - Submit RSVP
//
// Design notes:
// - No user input is interpolated into an Airtable filterByFormula string.
// - Duplicate detection keys on the guest's Airtable record id (stable), with a
//   fallback to the canonical GuestList name. The editable "Guest 1" field is
//   NOT used as the key, so editing it can never create a second row.
// - The deadline is timezone-explicit (Asia/Manila), not server-local.

const Airtable = require('airtable');

const RESPONSES_TABLE = 'Responses';
const GUEST_TABLE = 'GuestList';

// End of 30 November 2026, Manila time.
const DEADLINE = new Date('2026-11-30T23:59:59+08:00');

function normalise(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    const {
      guestId,           // Airtable record id from the search step (preferred key)
      guestListName,     // canonical name as stored in GuestList
      mainGuestName,     // what the guest typed in the Guest 1 field
      contactNumber,
      guestNames,
      attending,
      reservedSeats,
    } = req.body || {};

    if (!mainGuestName || !contactNumber || !attending) {
      return res.status(400).json({
        success: false,
        error: 'Please complete every field before submitting.',
      });
    }

    if (attending !== 'yes' && attending !== 'no') {
      return res.status(400).json({ success: false, error: 'Invalid attendance value.' });
    }

    if (new Date() > DEADLINE) {
      return res.status(403).json({
        success: false,
        error:
          'The RSVP deadline (30 November 2026) has passed. Please contact the couple directly.',
      });
    }

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    // Resolve the canonical guest-list name. This is the dedupe key and it never
    // changes, no matter what the guest types into the Guest 1 field.
    let canonicalName = guestListName;

    if (guestId && /^rec[A-Za-z0-9]{14}$/.test(guestId)) {
      try {
        const guestRecord = await base(GUEST_TABLE).find(guestId);
        canonicalName = guestRecord.get('Name') || canonicalName;
      } catch (lookupError) {
        console.warn('Guest lookup failed, falling back to submitted name:', lookupError.message);
      }
    }

    if (!canonicalName) canonicalName = mainGuestName;

    const cleanedGuestNames = Array.isArray(guestNames)
      ? guestNames.map((n) => String(n).trim()).filter(Boolean)
      : [];

    const totalAttending = attending === 'yes' ? cleanedGuestNames.length : 0;

    const responseData = {
      'Main Guest Name': canonicalName,
      'Contact Number': String(contactNumber).trim(),
      'Guest Names': cleanedGuestNames.join(', '),
      'Attending': attending === 'yes' ? 'Yes' : 'No',
      'Reserved Seats': Number(reservedSeats) || 0,
      'Total Attending': totalAttending,
      'Timestamp': new Date().toISOString(),
    };

    // Find an existing response by comparing normalised names in JS rather than
    // building a formula from user input.
    const existing = await base(RESPONSES_TABLE)
      .select({ fields: ['Main Guest Name'] })
      .all();

    const target = normalise(canonicalName);
    const match = existing.find(
      (record) => normalise(record.get('Main Guest Name')) === target
    );

    if (match) {
      await base(RESPONSES_TABLE).update(match.id, responseData);
    } else {
      await base(RESPONSES_TABLE).create(responseData);
    }

    return res.status(200).json({
      success: true,
      updated: Boolean(match),
      message: match ? 'Your RSVP has been updated.' : 'RSVP submitted successfully!',
    });
  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({
      success: false,
      error: 'Something went wrong on our end. Please try again in a moment.',
    });
  }
};