require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const pdfParse = require('pdf-parse');
const xlsx = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE
========================= */
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ca_consultation_hub');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: String,
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  createdAt: { type: Date, default: Date.now }
});

const ServiceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, default: 'General' },
  description: String,
  fee: { type: Number, required: true },
  duration: { type: Number, default: 30 }, // minutes
  active: { type: Boolean, default: true }
});

const BookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  mode: { type: String, enum: ['video', 'phone'], default: 'video' },
  notes: String,
  status: { type: String, enum: ['pending', 'paid', 'confirmed', 'completed', 'cancelled'], default: 'pending' },
  paymentId: String,
  razorpayOrderId: String,
  meetLink: String,
  createdAt: { type: Date, default: Date.now }
});

const DocumentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  fileName: String,
  fileType: String,
  extractedText: String,
  parsedData: Object,
  createdAt: { type: Date, default: Date.now }
});

const InvoiceSchema = new mongoose.Schema({
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
  invoiceNumber: { type: String, required: true },
  amount: Number,
  tax: Number,
  total: Number,
  status: { type: String, default: 'generated' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Service = mongoose.model('Service', ServiceSchema);
const Booking = mongoose.model('Booking', BookingSchema);
const Document = mongoose.model('Document', DocumentSchema);
const Invoice = mongoose.model('Invoice', InvoiceSchema);

/* =========================
   APP CONFIG
========================= */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'super_secret_session_key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ca_consultation_hub'
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir });

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'razorpay_secret_placeholder'
});

const mailTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null;

app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.services = await Service.find({ active: true }).sort({ fee: 1 });
  next();
});

/* =========================
   HELPERS
========================= */
function auth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function adminOnly(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }
  next();
}

async function sendEmail(to, subject, html) {
  if (!mailTransporter) return;
  try {
    await mailTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html
    });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

function calculateIndiaTax(regime, income, deductions = 0) {
  income = Number(income) || 0;
  deductions = Number(deductions) || 0;

  let taxableIncome = income;
  if (regime === 'old') taxableIncome = Math.max(0, income - deductions);

  let tax = 0;
  if (regime === 'new') {
    if (taxableIncome <= 300000) tax = 0;
    else if (taxableIncome <= 600000) tax = (taxableIncome - 300000) * 0.05 + 0;
    else if (taxableIncome <= 900000) tax = 15000 + (taxableIncome - 600000) * 0.10;
    else if (taxableIncome <= 1200000) tax = 45000 + (taxableIncome - 900000) * 0.15;
    else if (taxableIncome <= 1500000) tax = 90000 + (taxableIncome - 1200000) * 0.20;
    else tax = 150000 + (taxableIncome - 1500000) * 0.30;
  } else {
    if (taxableIncome <= 250000) tax = 0;
    else if (taxableIncome <= 500000) tax = (taxableIncome - 250000) * 0.05;
    else if (taxableIncome <= 1000000) tax = 12500 + (taxableIncome - 500000) * 0.20;
    else tax = 112500 + (taxableIncome - 1000000) * 0.30;
  }

  const cess = tax * 0.04;
  return {
    taxableIncome,
    tax: Math.round(tax),
    cess: Math.round(cess),
    totalTax: Math.round(tax + cess)
  };
}

async function createInvoiceForBooking(bookingId, serviceFee) {
  const invoiceNumber = `INV-${Date.now()}`;
  return await Invoice.create({
    bookingId,
    invoiceNumber,
    amount: serviceFee,
    tax: Math.round(serviceFee * 0.18),
    total: Math.round(serviceFee * 1.18),
    status: 'generated'
  });
}

/* =========================
   ROUTES
========================= */
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.render('login', { error: 'Name, email, and password are required.' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.render('login', { error: 'Email already exists.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, phone, role: 'user' });

    req.session.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    res.redirect('/app');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Registration failed.' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.render('login', { error: 'Invalid credentials.' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.render('login', { error: 'Invalid credentials.' });

    req.session.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    res.redirect('/app');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Login failed.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/app', auth, async (req, res) => {
  const bookings = req.session.user.role === 'admin'
    ? await Booking.find().populate('userId serviceId').sort({ createdAt: -1 })
    : await Booking.find({ userId: req.session.user.id }).populate('serviceId').sort({ createdAt: -1 });

  const documents = req.session.user.role === 'admin'
    ? await Document.find().sort({ createdAt: -1 })
    : await Document.find({ userId: req.session.user.id }).sort({ createdAt: -1 });

  const invoices = req.session.user.role === 'admin'
    ? await Invoice.find().sort({ createdAt: -1 })
    : await Invoice.find().sort({ createdAt: -1 });

  res.render('app', {
    bookings,
    documents,
    invoices,
    taxResult: null,
    message: null,
    payment: null
  });
});

/* CREATE SERVICE - ADMIN */
app.post('/service', auth, adminOnly, async (req, res) => {
  try {
    const { name, category, description, fee, duration } = req.body;
    await Service.create({ name, category, description, fee, duration });
    res.redirect('/app');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to create service');
  }
});

/* BOOK CONSULTATION */
app.post('/book', auth, async (req, res) => {
  try {
    const { serviceId, date, time, mode, notes } = req.body;
    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).send('Service not found');

    const booking = await Booking.create({
      userId: req.session.user.id,
      serviceId,
      date,
      time,
      mode,
      notes,
      status: 'pending'
    });

    const order = await razorpay.orders.create({
      amount: Math.round(service.fee * 100),
      currency: 'INR',
      receipt: `booking_${booking._id}`
    });

    booking.razorpayOrderId = order.id;
    await booking.save();

    const bookings = await Booking.find({ userId: req.session.user.id }).populate('serviceId').sort({ createdAt: -1 });
    const documents = await Document.find({ userId: req.session.user.id }).sort({ createdAt: -1 });
    const invoices = await Invoice.find().sort({ createdAt: -1 });

    res.render('app', {
      bookings,
      documents,
      invoices,
      taxResult: null,
      message: 'Booking created. Complete payment using Razorpay below.',
      payment: {
        orderId: order.id,
        amount: service.fee,
        keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
        bookingId: String(booking._id),
        serviceName: service.name,
        customerName: req.session.user.name,
        customerEmail: req.session.user.email
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to create booking');
  }
});

/* VERIFY PAYMENT (simple flow) */
app.post('/payment/verify', auth, async (req, res) => {
  try {
    const { bookingId, paymentId } = req.body;
    const booking = await Booking.findById(bookingId).populate('serviceId');
    if (!booking) return res.status(404).send('Booking not found');

    booking.status = 'paid';
    booking.paymentId = paymentId;
    booking.meetLink = booking.mode === 'video'
      ? 'https://meet.google.com/your-meet-link'
      : 'Phone call scheduled';
    await booking.save();

    const invoice = await createInvoiceForBooking(booking._id, booking.serviceId.fee);

    const user = await User.findById(booking.userId);
    await sendEmail(
      user.email,
      'Consultation Payment Received',
      `<h3>Payment Received</h3><p>Your booking has been paid successfully.</p><p>Invoice: ${invoice.invoiceNumber}</p>`
    );

    res.redirect('/app');
  } catch (err) {
    console.error(err);
    res.status(500).send('Payment verification failed');
  }
});

/* TAX CALCULATOR */
app.post('/tax-calc', auth, async (req, res) => {
  try {
    const { regime, income, deductions } = req.body;
    const taxResult = calculateIndiaTax(regime, income, deductions);

    const bookings = req.session.user.role === 'admin'
      ? await Booking.find().populate('userId serviceId').sort({ createdAt: -1 })
      : await Booking.find({ userId: req.session.user.id }).populate('serviceId').sort({ createdAt: -1 });

    const documents = req.session.user.role === 'admin'
      ? await Document.find().sort({ createdAt: -1 })
      : await Document.find({ userId: req.session.user.id }).sort({ createdAt: -1 });

    const invoices = await Invoice.find().sort({ createdAt: -1 });

    res.render('app', {
      bookings,
      documents,
      invoices,
      taxResult,
      message: 'Tax calculated successfully.',
      payment: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Tax calculation failed');
  }
});

/* UPLOAD DOCUMENTS (PDF / EXCEL) */
app.post('/upload', auth, upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded');

    const file = req.file;
    let extractedText = '';
    let parsedData = {};

    if (file.mimetype === 'application/pdf') {
      const buffer = fs.readFileSync(file.path);
      const data = await pdfParse(buffer);
      extractedText = data.text || '';
    } else if (
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls')
    ) {
      const wb = xlsx.readFile(file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      parsedData = xlsx.utils.sheet_to_json(ws);
      extractedText = JSON.stringify(parsedData);
    }

    await Document.create({
      userId: req.session.user.id,
      fileName: file.originalname,
      fileType: file.mimetype,
      extractedText,
      parsedData
    });

    fs.unlink(file.path, () => {});

    res.redirect('/app');
  } catch (err) {
    console.error(err);
    res.status(500).send('Upload processing failed');
  }
});

/* ADMIN CONFIRM BOOKING WITH MEET LINK */
app.post('/admin/confirm/:id', auth, adminOnly, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('userId serviceId');
    if (!booking) return res.status(404).send('Booking not found');

    booking.status = 'confirmed';
    booking.meetLink = req.body.meetLink || booking.meetLink || 'https://meet.google.com/your-meeting-link';
    await booking.save();

    await sendEmail(
      booking.userId.email,
      'Consultation Confirmed',
      `<h3>Your consultation is confirmed</h3><p>Mode: ${booking.mode}</p><p>Link: ${booking.meetLink}</p>`
    );

    res.redirect('/app');
  } catch (err) {
    console.error(err);
    res.status(500).send('Confirmation failed');
  }
});

/* INITIALIZE DEFAULT SERVICES IF NONE EXIST */
async function ensureDefaultServices() {
  const count = await Service.countDocuments();
  if (count === 0) {
    await Service.insertMany([
      { name: 'Income Tax Return Filing', category: 'Tax', description: 'ITR filing and tax assistance', fee: 1500, duration: 30 },
      { name: 'GST Consultation', category: 'GST', description: 'GST advisory and filing help', fee: 2000, duration: 45 },
      { name: 'Virtual CFO Advisory', category: 'Business', description: 'Monthly CFO style advisory', fee: 5000, duration: 60 },
      { name: 'Form 16 Review & Tax Planning', category: 'Tax', description: 'Document-based tax review', fee: 2500, duration: 40 }
    ]);
    console.log('Default services created');
  }
}

/* START SERVER */
mongoose.connection.once('open', async () => {
  await ensureDefaultServices();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
