require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Google Sheets setup
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Budget storage (in-memory, persists while server runs)
const budgets = {};

// System prompt
const SYSTEM_PROMPT = `You are Spendly, a friendly and witty AI Personal Finance Assistant on WhatsApp.

Your personality: Minimal, efficient, friendly, with a sense of humor. You make smart observations about spending habits — like "€47 σε καφέ αυτή την εβδομάδα... πήρες καμιά αύξηση; 😅"

CORE BEHAVIOR
- Read incoming WhatsApp messages naturally
- Detect expenses, amounts, merchants, categories, dates
- Convert unstructured text into structured financial entries
- Be fast, accurate, and conversational
- If uncertain, ask ONE short question
- Respond in the SAME language the user writes in (Greek, Greeklish, or English)

SUPPORTED INPUTS
- Simple: "kafes 3.5", "fuel 60"
- Multiple: "kafes 3.5 kai supermarket 42"
- Natural: "xtes benzini 60 euro"
- Greek: "καφές 3.50", "χθες βενζίνη 60"
- Budget setting: "budget coffee 80", "budget kafes 80"
- Summary request: "posá xódepsa?", "πόσα ξόδεψα;", "how much this month?"

OUTPUT FORMAT — Return JSON ONLY, no markdown, no explanation:

For expenses:
{"entries":[{"amount":12.50,"currency":"EUR","category":"Coffee","subcategory":"Coffee","merchant":null,"description":"kafes","date":"2026-05-09","payment_method":"unknown","confidence":0.96}],"needs_clarification":false,"question":null,"message":"✅ Καταγράφηκε! ☕ €3.50 για καφέ\n💳 Coffee: €31.50 / €80 αυτόν τον μήνα\n████░░░░░░ 39%"}

For budget setting:
{"type":"budget","category":"Coffee","amount":80,"message":"✅ Budget καφέ ορίστηκε στα €80/μήνα!"}

For clarification:
{"entries":[],"needs_clarification":true,"question":"Πόσο ήταν ο καφές και πόσο το φαγητό;","message":null}

For monthly summary — return this format:
{"type":"monthly_summary","message":"📊 *Μάιος 2026*\n━━━━━━━━━━━━━━━\n☕ Coffee:     €47.00\n🍽️ Φαγητό:    €210.00\n⛽ Fuel:       €60.00\n🛒 Market:     €82.00\n━━━━━━━━━━━━━━━\n💰 Σύνολο: €399.00\n📈 Συνέχισε έτσι! 💪"}

CATEGORIES: Food, Coffee, Supermarket, Transport, Fuel, Shopping, Entertainment, Bills, Health, Travel, Subscriptions, Rent, Income, Other

CATEGORY RULES:
- kafes, kafe, freddo, frappe, espresso, καφές, καφεδάκι → Coffee
- benzini, venzini, kaysima, βενζίνη, καύσιμα, shell, bp → Fuel
- super market, supermarket, sklavenitis, σκλαβενίτης, lidl, ab → Supermarket
- taxi, taksi, metro, leoforeio, μετρό, λεωφορείο, uber → Transport
- giatros, iatros, farmakeio, φαρμακείο, γιατρός, νοσοκομείο → Health
- enoikio, noiki, ενοίκιο, νοίκι → Rent
- revma, nero, internet, logariasmos, ρεύμα, νερό → Bills
- fagito, souvlaki, pizza, psomi, βραδινό, μεσημεριανό, εστιατόριο → Food
- rouxa, papoutsia, ρούχα, παπούτσια → Shopping
- netflix, spotify, sindromi → Subscriptions

DATE RULES:
- No date → use 2026-05-09
- "yesterday/xtes/χθες" → 2026-05-08
- "proxi/προχθές" → 2026-05-07

SMART OBSERVATIONS (add to message when spending seems high):
- 3+ coffees same day: "3η φορά καφές σήμερα... όλα καλά; ☕😅"
- Large restaurant bill: "Τρελή βραδιά; 😄"
- High fuel: "Ταξίδι το Σαββατοκύριακο; Να το βάλω ως Travel; 🚗"
- Over budget: "⚠️ Ξεπέρασες το budget σου σε αυτή την κατηγορία!"

IMPORTANT:
- Never invent amounts
- Handle "3,50" = 3.50
- Default currency: EUR
- Always return ONLY valid JSON`;

// Initialize sheet headers
async function initSheet() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Spendly!A1:J1',
    });
    if (!response.data.values || response.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Spendly!A1:J1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [['Date', 'Amount', 'Currency', 'Category', 'Subcategory', 'Merchant', 'Description', 'Payment Method', 'Notes', 'Created At']],
        },
      });
      console.log('Sheet headers initialized');
    }
  } catch (e) {
    console.log('Sheet init error:', e.message);
  }
}

// Get all sheet names from Google Sheets and find the monthly one
async function getMonthSheetName(dateStr) {
  try {
    const d = new Date(dateStr);
    const month = d.getMonth(); // 0-11
    const year = d.getFullYear();
    
    // Get all sheet names from the spreadsheet
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheetNames = meta.data.sheets.map(s => s.properties.title);
    console.log('Available sheets:', sheetNames);
    
    // Find sheet that contains the month number pattern
    // Months in Greek: Ιανουάριος=0, Φεβρουάριος=1, etc.
    const greekMonths = ['Ιανουάριος','Φεβρουάριος','Μάρτιος','Απρίλιος','Μάιος','Ιούνιος','Ιούλιος','Αύγουστος','Σεπτέμβριος','Οκτώβριος','Νοέμβριος','Δεκέμβριος'];
    const englishMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    
    const targetYear = String(year);
    const found = sheetNames.find(name => {
      const hasYear = name.includes(targetYear);
      const hasGreek = name.includes(greekMonths[month]);
      const hasEnglish = name.includes(englishMonths[month]);
      return hasYear && (hasGreek || hasEnglish);
    });
    
    console.log('Found monthly sheet:', found);
    return found || null;
  } catch(e) {
    console.log('getMonthSheetName error:', e.message);
    return null;
  }
}

// Get main sheet name
async function getMainSheetName() {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheetNames = meta.data.sheets.map(s => s.properties.title);
    const main = sheetNames.find(n => n.includes('Όλα') || n.includes('All') || n.includes('Overview'));
    return main || sheetNames[0];
  } catch(e) {
    return 'Sheet1';
  }
}

// Add entry to Google Sheet
async function addToSheet(entry) {
  const row = [
    entry.date,
    entry.amount,
    entry.currency || 'EUR',
    entry.category,
    entry.subcategory || '',
    entry.merchant || '',
    entry.description || '',
    entry.payment_method || 'unknown',
    '',
    new Date().toISOString(),
  ];

  // Write to main sheet
  try {
    const mainSheet = await getMainSheetName();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${mainSheet}!A:J`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    console.log('Written to main sheet:', mainSheet);
  } catch (e) {
    console.log('Main sheet error:', e.message);
  }

  // Write to monthly sheet
  try {
    const monthSheet = await getMonthSheetName(entry.date);
    if (monthSheet) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${monthSheet}!A:J`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
      console.log('Written to monthly sheet:', monthSheet);
    }
  } catch (e) {
    console.log('Monthly sheet error:', e.message);
  }
}

// Get monthly totals from sheet
async function getMonthlyTotals() {
  try {
    const monthSheet = await getMonthSheetName(new Date().toISOString().slice(0,10));
    if (!monthSheet) return { totals: {}, total: 0 };
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${monthSheet}!A:J`,
    });
    const rows = response.data.values || [];
    
    const totals = {};
    let total = 0;
    // Skip header rows, look for rows with valid date and amount
    rows.forEach(row => {
      if (row[0] && row[1] && row[0].match(/^\d{4}-\d{2}-\d{2}/)) {
        const cat = row[3] || 'Other';
        const amt = parseFloat(row[1]) || 0;
        if (amt > 0) {
          totals[cat] = (totals[cat] || 0) + amt;
          total += amt;
        }
      }
    });
    console.log('Monthly totals:', totals, 'Total:', total);
    return { totals, total };
  } catch (e) {
    console.log('getMonthlyTotals error:', e.message);
    return { totals: {}, total: 0 };
  }
}

// Send WhatsApp message
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      from: 'whatsapp:+14155238886',
      to: `whatsapp:${to}`,
      body: message,
    });
  } catch (e) {
    console.log('WhatsApp send error:', e.message);
  }
}

// Process message with Claude
async function processMessage(userMessage) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    const raw = response.content[0].text;
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.log('Claude error:', e.message);
    return null;
  }
}

// Weekly report
async function sendWeeklyReport(userPhone) {
  const { totals, total } = await getMonthlyTotals();
  const catEmoji = { Coffee: '☕', Fuel: '⛽', Supermarket: '🛒', Food: '🍽️', Transport: '🚗', Shopping: '🛍️', Entertainment: '🎬', Bills: '💡', Health: '💊', Travel: '✈️', Subscriptions: '📱', Rent: '🏠', Other: '📌' };
  
  let lines = `📊 *Εβδομαδιαία Σύνοψη*\n━━━━━━━━━━━━━━━\n`;
  Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
    const budget = budgets[cat.toLowerCase()];
    const bar = budget ? `${Math.round((amt / budget) * 10)}/${10}` : '';
    lines += `${catEmoji[cat] || '📌'} ${cat}: €${amt.toFixed(2)}${budget ? ` / €${budget}` : ''}\n`;
  });
  lines += `━━━━━━━━━━━━━━━\n💰 Σύνολο: €${total.toFixed(2)}`;
  
  await sendWhatsApp(userPhone, lines);
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const userMessage = req.body.Body;
  const userPhone = req.body.From?.replace('whatsapp:', '');
  
  console.log(`Message from ${userPhone}: ${userMessage}`);
  
  res.status(200).send('<Response></Response>');
  
  const parsed = await processMessage(userMessage);
  if (!parsed) {
    await sendWhatsApp(userPhone, 'Κάτι πήγε στραβά, δοκίμασε ξανά! 😅');
    return;
  }

  if (parsed.type === 'budget') {
    budgets[parsed.category.toLowerCase()] = parsed.amount;
    await sendWhatsApp(userPhone, parsed.message);
    return;
  }

  if (parsed.type === 'monthly_summary') {
    const { totals, total } = await getMonthlyTotals();
    const catEmoji = { Coffee: '☕', Fuel: '⛽', Supermarket: '🛒', Food: '🍽️', Transport: '🚗', Shopping: '🛍️', Entertainment: '🎬', Bills: '💡', Health: '💊', Travel: '✈️', Subscriptions: '📱', Rent: '🏠', Other: '📌' };
    let msg = `📊 *Μάιος 2026*\n━━━━━━━━━━━━━━━\n`;
    Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
      msg += `${catEmoji[cat] || '📌'} ${cat}: €${amt.toFixed(2)}\n`;
    });
    msg += `━━━━━━━━━━━━━━━\n💰 Σύνολο: €${total.toFixed(2)}`;
    await sendWhatsApp(userPhone, msg);
    return;
  }

  if (parsed.needs_clarification) {
    await sendWhatsApp(userPhone, parsed.question);
    return;
  }

  if (parsed.entries && parsed.entries.length > 0) {
    for (const entry of parsed.entries) {
      await addToSheet(entry);
      
      // Check budget
      if (budgets[entry.category.toLowerCase()]) {
        const budget = budgets[entry.category.toLowerCase()];
        const { totals } = await getMonthlyTotals();
        const spent = totals[entry.category] || 0;
        const pct = Math.round((spent / budget) * 100);
        const bars = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        const budgetLine = `\n💳 ${entry.category}: €${spent.toFixed(2)} / €${budget}\n${bars} ${pct}%`;
        const msg = (parsed.message || `✅ Καταγράφηκε! €${entry.amount}`) + budgetLine;
        await sendWhatsApp(userPhone, msg);
      } else {
        await sendWhatsApp(userPhone, parsed.message || `✅ Καταγράφηκε! €${entry.amount}`);
      }
    }
  }
});

// Weekly cron - every Sunday at 20:00
cron.schedule('0 20 * * 0', async () => {
  const userPhone = process.env.USER_PHONE;
  if (userPhone) await sendWeeklyReport(userPhone);
});

app.get('/', (req, res) => res.send('Spendly is running! 💸'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Spendly running on port ${PORT}`);
  await initSheet();
});
