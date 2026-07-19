import express from 'express';
import db from '../config/db.js';
import multer from 'multer';
import path from 'path';
import authController from "../controllers/authController.js";
import rolesController from '../controllers/rolesController.js';
import permissionsController from '../controllers/permissionsController.js';
import companiesController from '../controllers/companiesController.js';
import protectRoute from '../middlewares/protectRoute.js';
import { checkPermission } from "../middlewares/checkPermission.js";
import { attachPermissions } from "../middlewares/attachPermissions.js";
import { canHelper } from '../middlewares/canHelper.js';

const router = express.Router();

router.use(attachPermissions);
router.use(canHelper);

// Dashboards
router.get('/super_admin_dashboard', protectRoute, checkPermission('read:any_superadmin_dashboard'), authController.getSuperAdminDashboard);
router.get('/dashboard', protectRoute, checkPermission('read:any_company_dashboard'), authController.getDashboard);

// Accounts / Users
router.get('/', protectRoute, checkPermission('read:any_user'), authController.adminList);
router.get('/add', protectRoute, authController.addAdmin);
router.post('/add', protectRoute, authController.createAdmin);
router.get('/edit/:id', protectRoute, authController.editAdminForm);
router.post('/edit/:id', protectRoute, authController.updateAdmin);
router.get('/delete/:id', protectRoute, authController.deleteAdmin);
router.get('/view/:id', protectRoute, authController.viewAdmin);

// MISSION AI (redirect legacy inbox → interview schedule)
router.get('/ai-chat-inbox', protectRoute, checkPermission('read:any_ai_chat_box'), (req, res) =>
  res.redirect(302, '/admin/interviews/schedule')
);
router.get('/jd-history', protectRoute, authController.jdHistory);

// LinkedIn (used by MISSION / recruitment ops — kept for AI flows)
router.get('/linkedIn-posts', protectRoute, authController.getLinkedInPosts);
router.get('/linkedIn-post/:id', protectRoute, authController.getLinkedInPostByID);

// Roles
router.get('/roles', protectRoute, rolesController.rolesList);
router.get('/role-edit/:id', protectRoute, rolesController.editRole);
router.get('/role-add', protectRoute, rolesController.addRole);
router.post('/role-add', protectRoute, rolesController.createRole);
router.post('/role-edit/:id', protectRoute, rolesController.updateRole);
router.get('/roles/:id/permissions/edit', protectRoute, rolesController.getPermissionsToRole);
router.post('/roles/:id/permissions', protectRoute, rolesController.assignPermissionsToRole);
router.post('/update-role-session', protectRoute, rolesController.changeSession);

// Permissions (Super Admin)
router.get('/permission', protectRoute, rolesController.permissionsList);
router.get('/permission-edit/:id', protectRoute, permissionsController.editPermission);
router.get('/permission-add', protectRoute, permissionsController.addPermission);
router.post('/permission-add', protectRoute, permissionsController.createPermission);
router.post('/permission-edit/:id', protectRoute, permissionsController.updatePermission);

// Companies (Super Admin)
router.get('/companies', protectRoute, checkPermission('read:any_companies'), companiesController.companiesList);
router.get('/company-edit/:id', protectRoute, companiesController.editCompany);
router.get('/company-add', protectRoute, companiesController.addCompany);
router.post('/company-add', protectRoute, companiesController.createCompany);
router.post('/company-edit/:id', protectRoute, companiesController.updateCompany);

// Resume upload (utility)
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

router.post('/upload', upload.single('resume'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const sql = `INSERT INTO resumes (file_path, status) VALUES (?, 'pending')`;
    await db.query(sql, [filePath]);
    res.send('✅ Resume uploaded. It will be processed shortly.');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).send('DB Error');
  }
});

// Admin users list (legacy page)
router.get('/users', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM admins ORDER BY id DESC');
    res.render('users', { users: rows });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).send('Internal Server Error');
  }
});

export default router;
