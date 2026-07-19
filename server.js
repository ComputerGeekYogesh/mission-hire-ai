// Import required modules
import express from 'express';
import bodyParser from 'body-parser';
import session from 'express-session';
import flash from 'connect-flash';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import linkedinJobPostRoutes from './linkedin.js';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import { initAccessControl } from './accesscontrol.js';
import { verifyDatabaseConnection } from './config/db.js';
import candidateInterviewRoutes, { initCandidateInterviewModule } from './modules/candidate-interview/index.js';
import { interviewConfig } from './modules/candidate-interview/config.js';
import { getSessionSecret } from './config/env.js';

// Setup for __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (_req, res) => {
  res.type('image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'mission-favicon.svg'));
});
app.use('/uploads/interview-gate', express.static(interviewConfig.uploadsRoot));
app.use('/uploads/interview-recordings', express.static(interviewConfig.recordingsRoot));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session setup
app.use(
  session({
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
  })
);

app.use((req, res, next) => {
  res.locals.email = req.session.email || null;
  next();
});
app.use(flash());
app.use((req, res, next) => {
  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.error = req.flash('error');
  next();
});

await verifyDatabaseConnection();
await initAccessControl();
await initCandidateInterviewModule();

app.use(authRoutes);
app.use('/admin', adminRoutes);
app.use('/linkedin', linkedinJobPostRoutes);
app.use(candidateInterviewRoutes);
app.use('/api', apiRoutes);

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`✅ Mission Hire (browser video interviews) running on port ${PORT}`);
});
