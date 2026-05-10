// Vercel Serverless Function - Submit RSVP
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
    const { mainGuestName, contactNumber, guestNames, attending, reservedSeats } = req.body;

    // Validate required fields
    if (!mainGuestName || !contactNumber || !attending) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }

    // Check deadline (November 30, 2026)
    const deadline = new Date('2026-11-30T23:59:59');
    const now = new Date();
    
    if (now > deadline) {
      return res.status(403).json({
        success: false,
        error: 'RSVP deadline has passed. Submissions are no longer accepted.'
      });
    }

    // Initialize Airtable
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

    // Calculate total attending
    const totalAttending = attending === 'yes' ? (guestNames ? guestNames.length : 0) : 0;

    // Prepare data
    const responseData = {
      'Main Guest Name': mainGuestName,
      'Contact Number': contactNumber,
      'Guest Names': guestNames ? guestNames.join(', ') : '',
      'Attending': attending === 'yes' ? 'Yes' : 'No',
      'Reserved Seats': reservedSeats || 0,
      'Total Attending': totalAttending,
      'Timestamp': new Date().toISOString()
    };

    // Check if guest already has a response (to update instead of create)
    const existingRecords = await base('Responses').select({
      filterByFormula: `LOWER({Main Guest Name}) = LOWER('${mainGuestName.replace(/'/g, "\\'")}')`
    }).firstPage();

    if (existingRecords.length > 0) {
      // Update existing record
      await base('Responses').update(existingRecords[0].id, responseData);
    } else {
      // Create new record
      await base('Responses').create(responseData);
    }

    return res.status(200).json({
      success: true,
      message: 'RSVP submitted successfully!'
    });

  } catch (error) {
    console.error('Submit error:', error);
    return res.status(500).json({
      success: false,
      error: 'Server error. Please try again.'
    });
  }
};
