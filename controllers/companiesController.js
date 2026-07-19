import db from '../config/db.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import {sendverifyOtpEmail} from '../mailer.js';

let verifyotpMap = new Map(); // stores email-otp pairs temporarily

// Render login page


const companiesList = async (req, res) => {

  try {
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at DESC`);

    res.render('authpages/companies-list', {
      email: req.session.email,
      companies,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching company:', err);
    res.status(500).send('Error loading company page');
  }
};

const addCompany = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {

    const [roles] = await db.query(`SELECT * FROM roles WHERE name NOT IN ('superAdmin') ORDER BY created_at DESC`);

    res.render('authpages/company-add', {
      email: req.session.email,
      roles,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching companies:', err);
    res.status(500).send('Error loading company page');
  }
};

// Create admin
const createCompany = async (req, res) => {
  try {
    const { name, userName, email, phone } = req.body;
    let createdBy = req.session.user_id;

    // ---------------------------------------------------
    // ✅ CHECK IF EMAIL ALREADY EXISTS IN ADMINS TABLE
    // ---------------------------------------------------
    const [existingAdmin] = await db.execute(
      'SELECT id FROM admins WHERE email = ? LIMIT 1',
      [email]
    );

    if (existingAdmin.length > 0) {
      req.flash('error_msg', `Admin with email ${email} already exists! Please use a different email.`);
      return res.redirect('/admin/company-add');
    }

    // ---------------------------------------------------
    // CREATE COMPANY
    // ---------------------------------------------------
    const [companyResult] = await db.execute(
      'INSERT INTO companies (name,userName,email,phone,created_at) VALUES (?,?,?,?, NOW())',
      [name, userName, email, phone]
    );

    const company_id = companyResult.insertId;

    // ---------------------------------------------------
    // ASSIGN ADMIN ROLE
    // ---------------------------------------------------
    const [roles] = await db.query(`SELECT * FROM roles WHERE name IN ('admin')`);
    const role = roles[0];
    const role_id_assigned = role.id;

    await db.execute(
      'INSERT INTO admins (email,name,company_id,role_id,created_by,created_at) VALUES (?,?,?,?,?, NOW())',
      [email, name, company_id, role_id_assigned, createdBy]
    );

    // ---------------------------------------------------
    // INSERT DEFAULT CALL SETTINGS
    // ---------------------------------------------------
    const incoming_voice_gender = "female";
    const incoming_voice_name = "alloy";
    const incoming_voice_phrase = "this is Mission from Three Sixty Degree Cloud AI Assistant";

    const outgoing_voice_gender = "female";
    const outgoing_voice_name = "alloy";
    const outgoing_voice_phrase = "this is Mission from Three Sixty Degree Cloud AI Assistant";

    await db.execute(
      `INSERT INTO call_settings 
      (company_id, incoming_voice_gender, incoming_voice_name, incoming_voice_phrase, 
       outgoing_voice_gender, outgoing_voice_name, outgoing_voice_phrase, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        company_id,
        incoming_voice_gender,
        incoming_voice_name,
        incoming_voice_phrase,
        outgoing_voice_gender,
        outgoing_voice_name,
        outgoing_voice_phrase,
        createdBy
      ]
    );

    // ---------------------------------------------------
    // OTP + EMAIL VERIFICATION
    // ---------------------------------------------------
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    verifyotpMap.set(email, otp);
    setTimeout(() => verifyotpMap.delete(email), 5 * 60 * 1000);

    const token = crypto.randomBytes(20).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000);

    await db.execute(`CREATE TABLE IF NOT EXISTS email_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255),
      token VARCHAR(255),
      code VARCHAR(10),
      expires_at DATETIME
    )`);

    await db.execute(`DELETE FROM email_tokens WHERE email=?`, [email]);

    await db.execute(
      `INSERT INTO email_tokens (email, token, code, expires_at) VALUES (?,?,?,?)`,
      [email, token, otp, expiresAt]
    );

    await sendverifyOtpEmail(email, token, otp,name);

    req.flash('success_msg', 'Company Added Successfully!');
    res.redirect('/admin/companies');

  } catch (error) {
    console.log(error);

    if (error.code === 'ER_DUP_ENTRY') {
      req.flash('error_msg', `Email "${req.body.email}" already exists!`);
      return res.redirect('/admin/company-add');
    }

    req.flash('error_msg', 'Error creating Company!');
    return res.redirect('/admin/companies');
  }
};

// Update admin
const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const {name,email} = req.body;
    console.log(name);
    console.log(email);
    const sql = `UPDATE companies SET name = ?, email = ? WHERE id = ?`;
    const [result] = await db.execute(sql, [name, email, id]);

    if (result.affectedRows === 0) {
      console.error('companies not found');
      res.redirect('/admin/companies');
    }
    req.flash('success_msg', 'Company Updated Successfully!');
    res.redirect('/admin/companies');
  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error in updating companies!');
    res.redirect('/admin/companies');
  }
};

const editCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('SELECT a.role_id AS role_id, c.id AS id, c.name AS name, c.userName AS userName, c.email AS email, c.phone AS phone FROM admins AS a JOIN companies AS c ON a.company_id = c.id WHERE c.id = ?', [id]);
    const [roles] = await db.query(`SELECT * FROM roles ORDER BY created_at DESC`);
    console.log("editCompany",result);
    console.log("editCompanyid",id);
    // return false;
    const company = result[0];
    console.log(company);
    res.render('authpages/company-edit', {
      email: req.session.email,
      company,
      roles,
      currentPath: req.originalUrl
    });

  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error loading edit form!');
  }
};

// ✅ Export as a single default object
export default {
  companiesList,
  addCompany,
  editCompany,
  createCompany,
  updateCompany
};
