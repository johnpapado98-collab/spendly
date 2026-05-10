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

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const budgets = {};

const today = new Date().toISOString().slice(0,10);
const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);

const SYSTEM_PROMPT = `You are Spendly, a personal AI assistant on WhatsApp. Today is ${today}.

PERSONALITY:
- For tasks, expenses, reminders, notes: fast, minimal, professional. No jokes.
- For casual chat, small talk, "how are you", "thanks": warm, witty, slightly sarcastic. Like a smart friend.
- Never mix the two modes.

YOU HANDLE 4 THINGS:
1. FINANCE - expenses, budgets, summaries
2. TASKS - to-do items
3. REMINDERS - at specific date/time
4. IDEAS & NOTES

DETECTION:
- Amount + item = EXPENSE
- "task/να κάνω/να καλέσω/todo/na kanw" = TASK
- "θύμισέ μου/thimise mou/reminder/αύριο+action/date+action" = REMINDER
- "ιδέα/idea/σημείωσε/simeiose/note" = NOTE
- "τι έχω να κάνω/tasks μου/ti exw na kanw" = LIST_TASKS
- "reminders μου/ti reminders exw" = LIST_REMINDERS
- "ιδέες μου/idees mou/σημειώσεις" = LIST_IDEAS
- "πόσα ξόδεψα/posa xodepsa/summary/synolo/ti exodepsa" = MONTHLY_SUMMARY
- Anything else conversational = CHAT

OUTPUT JSON ONLY - no markdown, no explanation:

EXPENSE: {"type":"expense","entries":[{"amount":3.50,"currency":"EUR","category":"Coffee","subcategory":"Coffee","merchant":null,"description":"kafes","date":"${today}","payment_method":"unknown","confidence":0.97}],"needs_clarification":false,"question":null,"message":"✅ Καταγράφηκε! ☕ €3.50"}

TASK: {"type":"task","text":"Να καλέσω τον Γιώργη","message":"✅ Task προστέθηκε!"}

REMINDER: {"type":"reminder","text":"Να πάρω τηλέφωνο τον Γιώργη","datetime":"${tomorrow}T10:00:00","message":"⏰ Reminder για αύριο στις 10:00!"}

NOTE: {"type":"note","text":"Ιδέα για landing page","message":"💡 Σημειώθηκε!"}

LIST_TASKS: {"type":"list_tasks"}
LIST_REMINDERS: {"type":"list_reminders"}
LIST_IDEAS: {"type":"list_ideas"}
MONTHLY_SUMMARY: {"type":"monthly_summary"}
BUDGET: {"type":"budget","category":"Coffee","amount":80,"message":"✅ Budget καφέ €80/μήνα!"}
CHAT: {"type":"chat","message":"Καλά, αν και εσύ με κάνεις να δουλεύω ασταμάτητα 😄"}
CLARIFICATION: {"type":"clarification","question":"Πόσο ήταν ο καφές και πόσο το σουβλάκι;"}

CATEGORIES: Food, Coffee, Supermarket, Transport, Fuel, Shopping, Entertainment, Bills, Health, Travel, Subscriptions, Rent, Income, Other

CATEGORY RULES:
- kafes/freddo/frappe/espresso/καφές → Coffee
- benzini/kaysima/βενζίνη/shell/bp → Fuel
- supermarket/sklavenitis/lidl/ab → Supermarket
- taxi/metro/leoforeio/uber → Transport
- farmakeio/giatros/φαρμακείο → Health
- enoikio/noiki/ενοίκιο → Rent
- revma/nero/internet/logariasmos → Bills
- fagito/souvlaki/pizza/βραδινό → Food
- rouxa/papoutsia/ρούχα → Shopping
- netflix/spotify/sindromi → Subscriptions

DATE RULES:
- No date → ${today}
- αύριο/avrio → ${tomorrow}
- χθες/xtes → ${yesterday}
- "23 Ιουλίου" → 2026-07-23
- "23 Ιουλίου στις 15:00" → 2026-07-23T15:00:00
- No time given → T09:00:00

CHAT PERSONALITY EXAMPLES:
- "πώς είσαι" → "Καλά! Έτοιμος να καταγράψω ό,τι μου πεις 💪"
- "ευχαριστώ" → "Κάνω αυτό που ξέρω καλύτερα 😄"
- "βαριέμαι" → "Κι εγώ αλλά εγώ δουλεύω. Έχεις tasks εκκρεμείς 😏"
- "πες μου τι μπορείς να κάνεις" → Explain all 4 features with examples in a friendly way

IMPORTANT: Return ONLY valid JSON. Respond in the same language as the user.`;

// ─── SHEET HELPERS ───
async function getSheetNames() {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    return meta.data.sheets.map(s => s.properties.title);
  } catch(e) { return []; }
}

async function getMainSheetName() {
  const names = await getSheetNames();
  return names.find(n => n.includes('Όλα') || n.includes('All') || n.includes('Overview')) || names[0] || 'Sheet1';
}

async function getMonthSheetName(dateStr) {
  const d = new Date(dateStr);
  const month = d.getMonth();
  const year = d.getFullYear();
  const greek = ['Ιανουάριος','Φεβρουάριος','Μάρτιος','Απρίλιος','Μάιος','Ιούνιος','Ιούλιος','Αύγουστος','Σεπτέμβριος','Οκτώβριος','Νοέμβριος','Δεκέμβριος'];
  const english = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const names = await getSheetNames();
  return names.find(n => n.includes(String(year)) && (n.includes(greek[month]) || n.includes(english[month]))) || null;
}

async function appendRow(sheetName, row) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } catch(e) { console.log(`Append error [${sheetName}]:`, e.message); }
}

async function getRows(sheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${sheetName}!A:Z` });
    return res.data.values || [];
  } catch(e) { return []; }
}

async function updateCell(sheetName, row, col, value) {
  try {
    const colLetter = String.fromCharCode(64 + col);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!${colLetter}${row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] },
    });
  } catch(e) { console.log(`Update error:`, e.message); }
}

// ─── FINANCE ───
async function addExpense(entry) {
  const row = [entry.date, entry.amount, entry.currency||'EUR', entry.category, entry.subcategory||'', entry.merchant||'', entry.description||'', entry.payment_method||'unknown', '', new Date().toISOString()];
  const main = await getMainSheetName();
  await appendRow(main, row);
  const monthly = await getMonthSheetName(entry.date);
  if (monthly) await appendRow(monthly, row);
}

async function getMonthlyTotals() {
  try {
    const currentMonth = new Date().toISOString().slice(0,7);
    const main = await getMainSheetName();
    const rows = await getRows(main);
    const totals = {};
    let total = 0;
    rows.forEach(r => {
      if (r[0] && r[1] && r[0].startsWith(currentMonth)) {
        const cat = r[3] || 'Other';
        const amt = parseFloat(r[1].toString().replace(/[^0-9.]/g,'')) || 0;
        if (amt > 0) { totals[cat] = (totals[cat]||0) + amt; total += amt; }
      }
    });
    return { totals, total };
  } catch(e) { return { totals:{}, total:0 }; }
}

// ─── TASKS ───
async function addTask(text) {
  await appendRow('✅ Tasks', [today, text, 'pending', new Date().toISOString()]);
}

async function getTasks() {
  const rows = await getRows('✅ Tasks');
  return rows.filter(r => r[1] && (r[2] === 'pending' || !r[2]));
}

// ─── REMINDERS ───
async function addReminder(text, datetime) {
  await appendRow('⏰ Reminders', [datetime, text, 'pending', new Date().toISOString()]);
}

async function getReminders() {
  const rows = await getRows('⏰ Reminders');
  return rows.filter(r => r[1] && (r[2] === 'pending' || !r[2]));
}

async function checkAndSendReminders(userPhone) {
  try {
    const rows = await getRows('⏰ Reminders');
    const now = new Date();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0] || r[2] === 'sent') continue;
      const reminderTime = new Date(r[0]);
      if (reminderTime <= now) {
        await sendWhatsApp(userPhone, `⏰ *REMINDER*\n━━━━━━━━━━━━━━━\n${r[1]}\n━━━━━━━━━━━━━━━\nΑπάντησε "έγινε" αν το έκανες ✅`);
        await updateCell('⏰ Reminders', i+1, 3, 'sent');
      }
    }
  } catch(e) { console.log('checkReminders error:', e.message); }
}

// ─── IDEAS ───
async function addNote(text) {
  await appendRow('💡 Ιδέες', [today, text, new Date().toISOString()]);
}

async function getIdeas() {
  const rows = await getRows('💡 Ιδέες');
  return rows.filter(r => r[1]);
}

// ─── WHATSAPP ───
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({ from: 'whatsapp:+14155238886', to: `whatsapp:${to}`, body: message });
  } catch(e) { console.log('WhatsApp error:', e.message); }
}

async function processMessage(userMessage) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    return JSON.parse(res.content[0].text.replace(/```json|```/g,'').trim());
  } catch(e) { console.log('Claude error:', e.message); return null; }
}

const catEmoji = { Coffee:'☕', Fuel:'⛽', Supermarket:'🛒', Food:'🍽️', Transport:'🚗', Shopping:'🛍️', Entertainment:'🎬', Bills:'💡', Health:'💊', Travel:'✈️', Subscriptions:'📱', Rent:'🏠', Income:'💰', Other:'📌' };

// ─── WEBHOOK ───
app.post('/webhook', async (req, res) => {
  const userMessage = req.body.Body;
  const userPhone = req.body.From?.replace('whatsapp:', '');
  console.log(`[${userPhone}]: ${userMessage}`);
  res.status(200).send('<Response></Response>');
  if (!userMessage?.trim()) return;

  const parsed = await processMessage(userMessage);
  if (!parsed) { await sendWhatsApp(userPhone, 'Κάτι πήγε στραβά 😅 Δοκίμασε ξανά!'); return; }

  switch(parsed.type) {

    case 'expense':
      if (parsed.needs_clarification) { await sendWhatsApp(userPhone, parsed.question); break; }
      for (const entry of (parsed.entries || [])) {
        await addExpense(entry);
        let msg = parsed.message || `✅ Καταγράφηκε! €${entry.amount}`;
        if (budgets[entry.category?.toLowerCase()]) {
          const budget = budgets[entry.category.toLowerCase()];
          const { totals } = await getMonthlyTotals();
          const spent = totals[entry.category] || 0;
          const pct = Math.min(Math.round((spent/budget)*100), 100);
          const filled = Math.round(pct/10);
          msg += `\n💳 ${entry.category}: €${spent.toFixed(2)} / €${budget}\n${'█'.repeat(filled)}${'░'.repeat(10-filled)} ${pct}%`;
        }
        await sendWhatsApp(userPhone, msg);
      }
      break;

    case 'budget':
      budgets[parsed.category.toLowerCase()] = parsed.amount;
      await sendWhatsApp(userPhone, parsed.message);
      break;

    case 'monthly_summary': {
      const { totals, total } = await getMonthlyTotals();
      const now = new Date();
      const monthName = now.toLocaleString('el-GR', { month:'long' });
      let msg = `📊 *${monthName} ${now.getFullYear()}*\n━━━━━━━━━━━━━━━\n`;
      if (Object.keys(totals).length === 0) {
        msg += 'Δεν έχεις καταγράψει έξοδα ακόμα!';
      } else {
        Object.entries(totals).sort((a,b)=>b[1]-a[1]).forEach(([cat,amt]) => {
          msg += `${catEmoji[cat]||'📌'} ${cat}: €${amt.toFixed(2)}\n`;
        });
      }
      msg += `━━━━━━━━━━━━━━━\n💰 Σύνολο: €${total.toFixed(2)}`;
      await sendWhatsApp(userPhone, msg);
      break;
    }

    case 'task':
      await addTask(parsed.text);
      await sendWhatsApp(userPhone, parsed.message || '✅ Task προστέθηκε!');
      break;

    case 'list_tasks': {
      const tasks = await getTasks();
      if (tasks.length === 0) { await sendWhatsApp(userPhone, '✅ Δεν έχεις εκκρεμείς tasks!'); break; }
      let msg = `✅ *Tasks*\n━━━━━━━━━━━━━━━\n`;
      tasks.forEach((t,i) => { msg += `${i+1}. ${t[1]}\n`; });
      await sendWhatsApp(userPhone, msg);
      break;
    }

    case 'reminder':
      await addReminder(parsed.text, parsed.datetime);
      await sendWhatsApp(userPhone, parsed.message || '⏰ Reminder ορίστηκε!');
      break;

    case 'list_reminders': {
      const reminders = await getReminders();
      if (reminders.length === 0) { await sendWhatsApp(userPhone, '⏰ Δεν έχεις εκκρεμείς reminders!'); break; }
      let msg = `⏰ *Reminders*\n━━━━━━━━━━━━━━━\n`;
      reminders.forEach((r,i) => {
        try {
          const dt = new Date(r[0]);
          const dateStr = dt.toLocaleString('el-GR', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
          msg += `${i+1}. ${r[1]} — ${dateStr}\n`;
        } catch(e) { msg += `${i+1}. ${r[1]} — ${r[0]}\n`; }
      });
      await sendWhatsApp(userPhone, msg);
      break;
    }

    case 'note':
      await addNote(parsed.text);
      await sendWhatsApp(userPhone, parsed.message || '💡 Σημειώθηκε!');
      break;

    case 'list_ideas': {
      const ideas = await getIdeas();
      if (ideas.length === 0) { await sendWhatsApp(userPhone, '💡 Δεν έχεις σημειώσεις ακόμα!'); break; }
      let msg = `💡 *Ιδέες & Σημειώσεις*\n━━━━━━━━━━━━━━━\n`;
      ideas.forEach((r,i) => { msg += `${i+1}. ${r[1]}\n`; });
      await sendWhatsApp(userPhone, msg);
      break;
    }

    case 'chat':
      await sendWhatsApp(userPhone, parsed.message);
      break;

    case 'clarification':
      await sendWhatsApp(userPhone, parsed.question);
      break;

    default:
      await sendWhatsApp(userPhone, parsed.message || 'Δεν κατάλαβα, δοκίμασε ξανά!');
  }
});

// Check reminders every minute
cron.schedule('* * * * *', async () => {
  const userPhone = process.env.USER_PHONE;
  if (userPhone) await checkAndSendReminders(userPhone);
});

// Weekly report every Sunday 20:00
cron.schedule('0 20 * * 0', async () => {
  const userPhone = process.env.USER_PHONE;
  if (!userPhone) return;
  const { totals, total } = await getMonthlyTotals();
  let msg = `📊 *Εβδομαδιαία Σύνοψη*\n━━━━━━━━━━━━━━━\n`;
  Object.entries(totals).sort((a,b)=>b[1]-a[1]).forEach(([cat,amt]) => { msg += `${catEmoji[cat]||'📌'} ${cat}: €${amt.toFixed(2)}\n`; });
  msg += `━━━━━━━━━━━━━━━\n💰 Σύνολο: €${total.toFixed(2)}`;
  await sendWhatsApp(userPhone, msg);
});

app.get('/', (req, res) => res.send('Spendly v2 running! 💸'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Spendly v2 on port ${PORT}`));
