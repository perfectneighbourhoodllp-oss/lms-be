/**
 * Seed script — populates DB with sample users and leads
 * Run: npm run seed (from /server)
 */
require('dotenv').config({ path: '../.env' });
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Lead = require('../models/Lead');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/realestate-crm';

const users = [
  { name: 'Admin User', email: 'admin@perfectneighbourhood.com', password: 'password123', role: 'admin' },
  { name: 'Manager Sunil', email: 'sunilpandey@perfectneighbourhood.com', password: 'password123', role: 'manager' },
  { name: 'Manager Arun', email: 'arun@perfectneighbourhood.com', password: 'password123', role: 'manager' },
  { name: 'Manager Naresh', email: 'naresh@perfectneighbourhood.com', password: 'password123', role: 'manager' },
];

const leadTemplates = [
  { name: 'Amit Sharma', phone: '+919876543201', source: 'Instagram', status: 'New', notes: 'Interested in 2BHK' },
  { name: 'Sunita Patel', phone: '+919876543202', source: 'Ads', status: 'Called', notes: 'Budget ~60L' },
  { name: 'Vikram Nair', phone: '+919876543203', source: 'Referral', status: 'Interested', notes: 'Looking in Whitefield' },
  { name: 'Deepa Rao', phone: '+919876543204', source: 'Walk-in', status: 'Site Visit', notes: 'Visited 3 units' },
  { name: 'Karan Mehta', phone: '+919876543205', source: 'Website', status: 'Closed', notes: 'Booked 3BHK — Unit 204' },
  { name: 'Anjali Gupta', phone: '+919876543206', source: 'Instagram', status: 'New' },
  { name: 'Rohit Das', phone: '+919876543207', source: 'Ads', status: 'Called', notes: 'Callback needed' },
  { name: 'Meena Iyer', phone: '+919876543208', source: 'Referral', status: 'Interested' },
];

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Clear existing
  await User.deleteMany({});
  await Lead.deleteMany({});
  console.log('Cleared existing data');

  // Create users
  const created = await User.insertMany(
    users.map((u) => ({ ...u })) // passwords will be hashed by pre-save hook
  );

  // Workaround: insertMany skips hooks — create one by one
  await User.deleteMany({});
  const savedUsers = [];
  for (const u of users) {
    const doc = await User.create(u);
    savedUsers.push(doc);
    console.log(`Created user: ${doc.email} (${doc.role})`);
  }

  const admin = savedUsers.find((u) => u.role === 'admin');
  const salesUsers = savedUsers.filter((u) => u.role === 'sales');

  // Create leads with dates
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const twoDaysAgo = new Date(today); twoDaysAgo.setDate(today.getDate() - 2);

  const followUpDates = [today, yesterday, tomorrow, twoDaysAgo, today, yesterday, null, tomorrow];

  // for (let i = 0; i < leadTemplates.length; i++) {
  //   const tpl = leadTemplates[i];
  //   const assigned = salesUsers[i % salesUsers.length];
  //   await Lead.create({
  //     ...tpl,
  //     followUpDate: followUpDates[i],
  //     assignedTo: assigned._id,
  //     createdBy: admin._id,
  //   });
  //   console.log(`Created lead: ${tpl.name}`);
  // }

  console.log('\n✅ Seed complete!');
  console.log('─'.repeat(40));
  users.forEach((u) => console.log(`  ${u.role.padEnd(8)} | ${u.email} | password: ${u.password}`));
  console.log('─'.repeat(40));
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
