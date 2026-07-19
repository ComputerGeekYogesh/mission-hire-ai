import db from '../config/db.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import {sendOtpEmail} from '../mailer.js';

let otpMap = new Map(); // stores email-otp pairs temporarily

// Render login page


const permissionsList = async (req, res) => {

  try {
    const [permissions] = await db.query(`SELECT * FROM permissions ORDER BY created_at DESC`);

    res.render('authpages/permissions-list', {
      email: req.session.email,
      permissions,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching Permissions:', err);
    res.status(500).send('Error loading permission page');
  }
};

const addPermission = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {
    const types = ['create', 'read', 'update', 'delete'];
    res.render('authpages/permission-add', {
      email: req.session.email,
      types,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching Permissions:', err);
    res.status(500).send('Error loading Users page');
  }
};

// Create admin
const createPermission = async (req, res) => {
  try {
    // name can be a string or an array (from <select name="name[]">)
    const { name, resource } = req.body;

    // Normalize to array and remove empty values
    let types = Array.isArray(name) ? name : (name ? [name] : []);
    types = types.map(t => (typeof t === 'string' ? t.trim() : t)).filter(Boolean);

    if (types.length === 0) {
      req.flash('error_msg', 'Please select at least one permission type.');
      return res.redirect('/admin/permission');
    }

    // Build placeholders for multi-row insert: (?, ?, NOW()), (?, ?, NOW()), ...
    const placeholders = types.map(() => '(?, ?, NOW())').join(', ');
    const params = [];
    for (const t of types) params.push(t, resource);

    const sql = `INSERT INTO permissions (action, resource, created_at) VALUES ${placeholders}`;
    await db.execute(sql, params);

    req.flash('success_msg', 'Permission(s) Added Successfully!');
    return res.redirect('/admin/permission');
  } catch (error) {
    console.error('Error creating permission(s):', error);
    req.flash('error_msg', 'Error creating Permission!');
    return res.redirect('/admin/permission');
  }
};

// Update admin
const updatePermission = async (req, res) => {
  try {
    const { id } = req.params;
    const {name,resource} = req.body;
    const sql = `UPDATE permissions SET action = ?,resource = ? WHERE id = ?`;
    const [result] = await db.execute(sql, [name, resource, id]);
    if (result.affectedRows === 0) {
      console.error('permission not found');
      res.redirect('/admin/permission');
    }
    req.flash('success_msg', 'Permission Updated Successfully!');
    res.redirect('/admin/permission');
  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error in updating Permissions!');
    res.redirect('/admin/permission');
  }
};

const editPermission = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('SELECT * FROM permissions WHERE id = ?', [id]);
    const permission = result[0];
    const types = ['create', 'read', 'update', 'delete'];
    console.log(permission);
    res.render('authpages/permissions-edit', {
      email: req.session.email,
      permission,
      types,
      currentPath: req.originalUrl
    });

  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error loading edit form!');
  }
};

// ✅ Export as a single default object
export default {
  permissionsList,
  addPermission,
  editPermission,
  createPermission,
  updatePermission
};
