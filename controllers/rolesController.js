import db from '../config/db.js';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import {sendOtpEmail} from '../mailer.js';
import { ac } from '../accesscontrol.js';

let otpMap = new Map(); // stores email-otp pairs temporarily

// Render login page

const rolesList = async (req, res) => {


  try {

    const roleId = parseInt(req.session.role_id, 10);
    const sessionUserId = req.session.user_id ? parseInt(req.session.user_id, 10) : null;
    let isSperAdmin = roleId === 1;
    let isAdmin = roleId === 2;

    let createdByIds = [];
    let createdById = '';
    let createdBySingle = null;
    let companyIdToFilter = null;
    // Helper to fetch admin IDs by company
    async function getAdminIdsByCompany(companyId) {
      const [rows] = await db.query('SELECT id FROM admins WHERE company_id = ?', [companyId]);
      return rows.map(r => parseInt(r.id, 10)).filter(n => !Number.isNaN(n));
    }

    // -----------------------------
    // Determine company scope
    // -----------------------------
    if (roleId === 1) {
      // Super admin
      companyIdToFilter = req.session.company_id
        ? parseInt(req.session.company_id, 10)
        : 0; // default company
      // fetch all admins under this company
      // createdByIds = await getAdminIdsByCompany(companyIdToFilter);
      createdById = req.session.company_id;
     
    } else if(roleId === 2){

      // Normal admin
      // if (sessionUserId) {
      //   const [adminRow] = await db.query('SELECT company_id FROM admins WHERE id = ? LIMIT 1', [sessionUserId]);
      //   companyIdToFilter = adminRow?.[0]?.company_id ? parseInt(adminRow[0].company_id, 10) : 1; // fallback to 1
      // }

      // If session has company override
      // if (req.session.company_id) {
        companyIdToFilter = parseInt(req.session.company_id, 10);
        createdById = req.session.company_id;
      // }

      // createdByIds = await getAdminIdsByCompany(companyIdToFilter);
      
    }else {
      // // Normal admin
      // if (sessionUserId) {
      //   const [adminRow] = await db.query('SELECT company_id FROM admins WHERE id = ? LIMIT 1', [sessionUserId]);
      //   companyIdToFilter = adminRow?.[0]?.company_id ? parseInt(adminRow[0].company_id, 10) : 1; // fallback to 1
      // }

      // // If session has company override
      // if (req.session.company_id) {
      //   companyIdToFilter = parseInt(req.session.company_id, 10);
      // }

      // createdByIds = await getAdminIdsByCompany(companyIdToFilter);
      // isAdmin = false;
      var createdByUserId = sessionUserId;
      companyIdToFilter = 1;
      isSperAdmin = false;
      isAdmin = false;
    }


    //  if(companyIdToFilter == 0){
    //      isAdmin = true;
    //   }else{
    //      isAdmin = false;
    //   }

    // --- build owner WHERE fragment and params ---
    // If isAdmin -> no owner filter
    let ownerWhere = '';
    let ownerParams = [];

    // if (!isAdmin) {
    //   if (Array.isArray(createdByIds)) {
    //     if (createdByIds.length === 0) {
    //       // No admins for company -> force no rows
    //       ownerWhere = ' WHERE 1 = 0';
    //       ownerParams = [];
    //     } else {
    //       ownerWhere = ' WHERE roles.created_by IN (?)';
    //       ownerParams = [createdByIds];
    //     }
    //   } else if (createdBySingle) {
    //     ownerWhere = ' WHERE roles.created_by = ?';
    //     ownerParams = [createdBySingle];
    //   } else {
    //     // No session user and not admin -> force no rows
    //     ownerWhere = ' WHERE 1 = 0';
    //     ownerParams = [];
    //   }
    // }


    // if (!isAdmin) {
    //  if (createdById) {
    //     ownerWhere = ' WHERE roles.account_id = ?';
    //     ownerParams = [createdById];
    //   }else{
    //     ownerWhere = ' WHERE roles.created_by = ?';
    //     ownerParams = [createdByUserId];
    //   }
    // }else{
    //   ownerWhere = ' WHERE roles.is_super_admin = true AND roles.account_id = ?';
    //   ownerParams = [createdById];
    // }

    if (isSperAdmin) {
      ownerWhere = ' WHERE name NOT IN ("superAdmin")';
      ownerParams = [];
    }else if(isAdmin){
      ownerWhere = ' WHERE name NOT IN ("admin", "superAdmin")';
      ownerParams = [];
    }else{
      ownerWhere = ' WHERE roles.created_by = ?';
      ownerParams = [createdById];
    }

    // If you want to include rows where j.user_id IS NULL and still show them for admins,
    // you would need to adapt the WHERE clause. Current logic filters by j.user_id.

  

    // --- data query (paginated) ---
    let dataSql = `
      SELECT * FROM roles
      ${ownerWhere}
      ORDER BY roles.id DESC
    `;

    const [roles] = await db.query(dataSql, ownerParams);

    // companies for filter UI
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at ASC`);
    const selectedCompanyId = req.session.selectedCompanyId || companyIdToFilter;

    res.render('authpages/roles-list', {
      email: req.session.email,
      roles,
      companies,
      selectedCompanyId,
      currentPath: req.originalUrl
    });
  } catch (err) {
    console.error('Error fetching roles:', err);
    res.status(500).send('Error loading roles page');
  }
};

const addRole = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {

    res.render('authpages/role-add', {
      email: req.session.email,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching Users:', err);
    res.status(500).send('Error loading Users page');
  }
};

// Create admin
const createRole = async (req, res) => {
  try {
    const {name} = req.body;
    var createdById = req.session.user_id;
    
    console.log(name);
    await db.execute('INSERT INTO roles (name,created_by,created_at) VALUES (?,?, NOW())', [name,createdById]);
    req.flash('success_msg', 'Role Added Successfully!');
    res.redirect('/admin/roles');
  } catch (error) {
    console.log(error);
    req.flash('error_msg', 'Error creating User!');
   
  }
};

// Update admin
const updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    const {name} = req.body;
    var createdById = req.session.user_id;
    
    console.log(name);
    const sql = `UPDATE roles SET name = ?,created_by = ? WHERE id = ?`;
    const [result] = await db.execute(sql, [name, createdById,id]);
    if (result.affectedRows === 0) {
      console.error('Role not found');
      res.redirect('/admin/roles');
    }
    req.flash('success_msg', 'Role Updated Successfully!');
    res.redirect('/admin/roles');
  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error in updating User!');
    res.redirect('/admin/roles');
  }
};

const editRole = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('SELECT * FROM roles WHERE id = ?', [id]);
    
    console.log(id);
    const role = result[0];
    console.log(role);
    res.render('authpages/roles-edit', {
      email: req.session.email,
      role,
      currentPath: req.originalUrl
    });

  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error loading edit form!');
  }
};

const getPermissionsToRole = async (req, res) => {
  try {
   const { id  } = req.params;
   
    // Fetch all permissions
    // const [allPermissions] = await db.query('SELECT id, action, resource FROM permissions');
    // console.log(allPermissions);
    // Fetch permissions already assigned to the role
     if (parseInt(req.session.role_id) == 1) {
      // Return all permissions for Super Admin
      var [allPermissions] = await db.query('SELECT id, action, resource FROM permissions');
      // const [permissions] = await db.query(`SELECT * FROM permissions`);
      // return res.json({ permissions });
    }else{
      var [allPermissions] = await db.query(`
    SELECT p.*
    FROM permissions p
    JOIN role_permissions rap ON rap.permission_id = p.id
    WHERE rap.role_id = ?
  `, [parseInt(req.session.role_id)]);

    }

    const [rolePermissions] = await db.query(
      'SELECT permission_id FROM role_permissions WHERE role_id = ?',
      [id]
    );

    const assignedPermissionIds = rolePermissions.map(rp => rp.permission_id);

    res.render('authpages/role-permissions', {
      email: req.session.email,
      roleId:id,
      permission: allPermissions,
      assignedPermissionIds,
      currentPath: req.originalUrl
    });

  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Failed to load permissions.');
  }
};

const assignPermissionsToRole = async (req, res) => {
  try {
    const { id } = req.params; // role ID
    const { permission } = req.body;

    // console.log(`Updating permissions for role ID: ${id}`);
    console.log('Permissions:', permission);

    // Example: delete old permissions and insert new ones
    await db.execute('DELETE FROM role_permissions WHERE role_id = ?', [id]);

    for (const perm of permission) {
      const [permData] = await db.execute(
        'SELECT id FROM permissions WHERE resource = ? AND action = ?',
        [perm.resource, perm.action]
      );

      if (permData.length) {
        await db.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [id, permData[0].id]
        );
      }
      
      // ac.grant(id.toString())[perm.action](perm.resource);
    }
    ac.removeRoles(id.toString());
    const [rolePerms] = await db.execute(
      `SELECT p.action, p.resource 
       FROM permissions p 
       JOIN role_permissions rp ON rp.permission_id = p.id 
       WHERE rp.role_id = ?`, [id]
    );

    // Re-add permissions to AccessControl
    rolePerms.forEach(perm => {
      ac.grant(id.toString())[perm.action](perm.resource);
    });

     res.json({ message: 'Permissions updated successfully!' });
  } catch (error) {
    console.error('Error updating permissions:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const changeSession = async (req, res) => {
  try {
  const { company_id } = req.body;
  
  if (!company_id || company_id === '0') {
    req.session.role_id = 1;
    req.session.company_id = undefined;
    console.log('Updated role:', req.session.role_id);
    req.session.selectedCompanyId = company_id;
    return res.json({ success: true });
      // return res.status(400).json({ success: false, message: 'Company ID missing' });
    }

  const [result] = await db.query('SELECT id,role_id FROM admins WHERE company_id = ?', [company_id]);
  console.log('session role:', result[0].role_id);
  // req.session.role_id = result[0].role_id;
  req.session.company_id = company_id;
  req.session.selectedCompanyId = company_id;
  req.session.isLoggedIn = true;
  console.log('Updated company_id role:', req.session.company_id);

  return res.json({ success: true });
  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error updating permissions.');
    res.redirect(`/admin/roles`);
  }
};

const permissionsList = async (req, res) => {
  try {
    const [permission] = await db.query(`SELECT * FROM permissions ORDER BY created_at DESC`);

    res.render('authpages/permissions-list', {
      email: req.session.email,
      permission,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching Permissions:', err);
    res.status(500).send('Error loading permission page');
  }
};

// ✅ Export as a single default object
export default {
  rolesList,
  addRole,
  editRole,
  createRole,
  updateRole,
  assignPermissionsToRole,
  getPermissionsToRole,
  changeSession,
  permissionsList
};
