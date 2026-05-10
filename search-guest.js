// Vercel Serverless Function - Search Guest
const Airtable = require('airtable');

module.exports = async (req, res) => {
  // Enable CORS
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
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    // Initialize Airtable
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

    // Search for guest in GuestList table
    const records = await base('GuestList').select({
      filterByFormula: `LOWER({Name}) = LOWER('${name.trim().replace(/'/g, "\\'")}')`
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Guest not found in the list. Please check the spelling.' 
      });
    }

    const record = records[0];
    
    return res.status(200).json({
      success: true,
      guest: {
        id: record.id,
        name: record.get('Name'),
        seats: record.get('Reserved Seats') || 0
      }
    });

  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Server error. Please try again.' 
    });
  }
};
