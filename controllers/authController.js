import db from '../config/db.js';
import {sendOtpEmail} from '../mailer.js';
import path from "path";
import { fileURLToPath } from 'url';
import {
  getJudgeDemoLoginOtp,
  getJudgeDemoLoginEmail,
  isJudgeDemoLoginEmail,
  isJudgeDemoLoginEnabled,
} from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let otpMap = new Map(); // stores email-otp pairs temporarily

// Render login page
const getLogin = (req, res) => {
  res.render('login', {
    judgeDemoLogin: isJudgeDemoLoginEnabled(),
    demoEmail: getJudgeDemoLoginEmail(),
  });
};

const getLanding = (req, res) => {
  res.render('home');
}


// Send OTP
const sendOTP = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  try {
    // 1. Check if admin/user exists
    const [admins] = await db.execute(
      `SELECT id, email, name, company_id FROM admins WHERE LOWER(email) = ? LIMIT 1`,
      [email]
    );

    if (!admins || admins.length === 0) {
      req.flash('error_msg', 'Email ID not found');
      return res.redirect('/login');
    }

    const admin = admins[0];
    const companyId = admin.company_id;

    // 2. If no company assigned → allow OTP
    const noCompany =
      companyId === null ||
      companyId === undefined ||
      companyId === 0 ||
      companyId === '';

    if (!noCompany) {
      // 3. Check if company exists
      const [companies] = await db.execute(
        `SELECT id, is_verified FROM companies WHERE id = ? LIMIT 1`,
        [companyId]
      );

      if (!companies || companies.length === 0) {
        req.flash('error_msg', 'Associated company not found.');
        return res.redirect('/');
      }

      const company = companies[0];

      // 4. Check if company is active
      const companyIsActive = Number(company.is_verified) === 1;

      if (!companyIsActive) {
        req.flash(
          'error_msg',
          'Company account is inactive. Please contact support.'
        );
        return res.redirect('/');
      }
    }

    let userName = admin.name || 'User';
    const demoLogin = isJudgeDemoLoginEmail(email);
    // 5. Passed all checks → Generate OTP
    const otp = demoLogin ? getJudgeDemoLoginOtp() : Math.floor(100000 + Math.random() * 900000).toString();
    if (!demoLogin) {
      console.log('OTP:', otp);
    } else {
      console.log('[judge-demo] OTP email skipped for demo login');
    }

    otpMap.set(email, otp);
    setTimeout(() => otpMap.delete(email), 5 * 60 * 1000); // expires in 5 mins

    if (!demoLogin) {
      try {
        await sendOtpEmail(email, otp, userName);
      } catch (mailErr) {
        console.error('OTP email delivery failed:', mailErr.message);
        req.flash(
          'error_msg',
          'Could not send OTP email. Check Gmail SMTP settings (MAIL_USERNAME / MAIL_PASSWORD) in .env and restart the server.'
        );
        return res.redirect('/login');
      }
    }

    return res.render('verify', {
      email,
      judgeDemoLogin: demoLogin,
      demoOtp: demoLogin ? getJudgeDemoLoginOtp() : '',
    });

  } catch (err) {
    console.error('sendOTP error:', err);
    req.flash('error_msg', 'Something went wrong. Please try again.');
    return res.redirect('/');
  }
};
 

const verifyOTP = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const otp = String(req.body.otp || '').trim();

  try {
    const demoLogin = isJudgeDemoLoginEmail(email);
    const otpValid =
      demoLogin && otp === getJudgeDemoLoginOtp()
        ? true
        : otpMap.get(email) === otp;

    // 1. Validate OTP
    if (!otpValid) {
      req.flash('error_msg', 'Invalid OTP');
      return res.redirect('/login');
    }

    // 2. Get admin user
    const [admins] = await db.execute(
      'SELECT id, name, role_id, company_id, email FROM admins WHERE LOWER(email) = ? LIMIT 1',
      [email]
    );

    if (!admins || admins.length === 0) {
      req.flash('error_msg', 'No account found for this email.');
      return res.redirect('/');
    }

    const admin = admins[0];
    const roleId = parseInt(admin.role_id, 10);

    // 3. Create session
    req.session.isLoggedIn = true;
    req.session.email = admin.email;
    req.session.user_id = admin.id;
    req.session.role_id = admin.role_id;
    req.session.name = admin.name;

    // 4. Set company_id only if exists
    if (admin.company_id) {
      req.session.company_id = admin.company_id;
    }else{
      req.session.company_id = 1;
    }

    console.log("company_id",req.session.company_id);

    if(roleId === 1){
      req.session.is_super_admin = 1;
    }

    // Remove OTP
    otpMap.delete(email);

    // 5. Redirect based on role
    if (roleId === 1) return res.redirect('/admin/super_admin_dashboard');
    if (roleId === 2) return res.redirect('/admin/dashboard');
    
    return res.redirect('/admin/interviews/schedule');

  } catch (err) {
    console.error('verifyOTP error:', err);
    req.flash('error_msg', 'Something went wrong. Please try again.');
    return res.redirect('/');
  }
};

// Super Admin Dashboard
const getSuperAdminDashboard = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {
    
    const [
      [companyCount],
      [activeCompanyCount],
      [jobsCount],
      [candidatesCount],
      [filteredCount],
      [failed],
      [recentJobs],
      [lastSeavenDaysCandidates],
      [lastSeavenDaysJobs],
      [lastSeavenDaysPassedCandidates],
      [overviewJobs],
      [overviewCandidates],
      [overviewCallDoneCandidates],
      [overviewFailedCandidates],
      [overviewPassCandidates]
    ] = await Promise.all([
      db.query('SELECT COUNT(*) AS count FROM companies'),
      db.query('SELECT COUNT(*) AS count FROM companies WHERE `is_verified` = 1'),
      db.query('SELECT COUNT(*) AS count FROM jobs'),
      db.query('SELECT COUNT(*) AS count FROM overall_status'),
      db.query("SELECT COUNT(*) AS count FROM overall_status WHERE result_status = 'Passed'"),
      db.query("SELECT COUNT(*) AS count FROM overall_status WHERE result_status = 'Failed'"),
      db.query(`
        SELECT 
          j.job_id AS job_id,
          j.title,
          j.created_at,
          COUNT(c.id) AS total_candidates
        FROM jobs j
        LEFT JOIN overall_status c 
          ON j.job_id = c.job_id
        GROUP BY j.job_id, j.title, j.created_at
        ORDER BY j.created_at DESC
        LIMIT 5
      `),
      db.query(`
        SELECT days.day, DAYNAME(days.day) AS day_name, 
               COALESCE(COUNT(j.created_at), 0) AS count 
        FROM (
          SELECT CURDATE() - INTERVAL n DAY AS day 
          FROM (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL 
                SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) AS numbers
        ) AS days 
        LEFT JOIN overall_status j 
          ON DATE(j.created_at) = days.day
        GROUP BY days.day 
        ORDER BY days.day ASC
      `),
      db.query(`
        SELECT days.day, DAYNAME(days.day) AS day_name, 
               COALESCE(COUNT(j.created_at), 0) AS job_count 
        FROM (
          SELECT CURDATE() - INTERVAL n DAY AS day 
          FROM (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL 
                SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) AS numbers
        ) AS days 
        LEFT JOIN jobs j 
          ON DATE(j.created_at) = days.day
        GROUP BY days.day 
        ORDER BY days.day ASC
      `),
      db.query(`
        SELECT days.day, DAYNAME(days.day) AS day_name, 
               COALESCE(COUNT(j.created_at), 0) AS count 
        FROM (
          SELECT CURDATE() - INTERVAL n DAY AS day 
          FROM (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL 
                SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) AS numbers
        ) AS days 
        LEFT JOIN overall_status j 
          ON DATE(j.created_at) = days.day 
         AND j.result_status = 'Passed'
        GROUP BY days.day 
        ORDER BY days.day ASC
      `),db.query(`
  SELECT COUNT(*) AS count
  FROM jobs
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
`),db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
`)
,db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') AND sid IS NOT NULL
  AND sid != ''
`),db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND result_status = 'Failed'
`),db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND result_status = 'Passed'
`)
    ]); 
    
    // console.log(overviewJobs);

    // return false;

    // return false;
    const stats = {
      company: companyCount[0].count,
      activeCompany: activeCompanyCount[0].count,
      jobs: jobsCount[0].count,
      candidates: candidatesCount[0].count,
      filtered: filteredCount[0].count,
      fail: failed[0].count,
      callOverviewJobs: overviewJobs[0].count,
      callOverviewCandidates: overviewCandidates[0].count,
      callOverviewCallDoneCandidates: overviewCallDoneCandidates[0].count,
      calloverviewFailedCandidates: overviewFailedCandidates[0].count,
      calloverviewPassCandidates: overviewPassCandidates[0].count,
    };

    const options = { year: 'numeric', month: 'long' };
    const currentMonthYear = new Date().toLocaleDateString('en-US', options);
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at DESC`);

    res.render('authpages/super-admin-dashboard', {
      email: req.session.email,
      stats,
      recentJobs,
      lastSeavenDaysJobs,
      lastSeavenDaysCandidates,
      lastSeavenDaysPassedCandidates,
      currentPath: req.originalUrl,
      currentMonthYear,
      companies
    });

  } catch (err) {
    console.error('Error loading dashboard:', err);
    res.status(500).send('Error loading dashboard');
  }
};

// Dashboard
const getDashboard = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {

    const roleId = parseInt(req.session.role_id, 10);
    const sessionUserId = req.session.user_id ? parseInt(req.session.user_id, 10) : null;
    let isSuperAdmin = roleId === 1;
    let companyIdToFilter = null;

    
    if (roleId === 1) {
      // Super admin
      companyIdToFilter = req.session.company_id
        ? parseInt(req.session.company_id, 10)
        : 0; // default company
      
     
    }else if(roleId === 2){
      // admin
      companyIdToFilter = parseInt(req.session.company_id, 10);
      isSuperAdmin = false;

    } else {
      // Normal admin
      if (sessionUserId) {
        const [adminRow] = await db.query('SELECT company_id FROM admins WHERE id = ? LIMIT 1', [sessionUserId]);
        companyIdToFilter = adminRow?.[0]?.company_id ? parseInt(adminRow[0].company_id, 10) : 1; // fallback to 1
      }
      var createdByUserId = sessionUserId;
      isSuperAdmin = false;

      
   }


   
    const buildOwnerFragments = () => {
      if (isSuperAdmin) return {
          plain: { sql: ' AND account_id = ?', params: [companyIdToFilter] },
          jobs: { sql: ' AND jobs.account_id = ?', params: [companyIdToFilter] },
          overall: { sql: ' AND overall_status.account_id = ?', params: [companyIdToFilter] }
        };

      // single user case
      if (companyIdToFilter) {
       return {
          plain: { sql: ' AND account_id = ?', params: [companyIdToFilter] },
          jobs: { sql: ' AND jobs.account_id = ?', params: [companyIdToFilter] },
          overall: { sql: ' AND overall_status.account_id = ?', params: [companyIdToFilter] }
        };
      }

       if (createdByUserId) {
        return {
          plain: { sql: ' AND created_by = ?', params: [createdByUserId] },
          jobs: { sql: ' AND jobs.created_by = ?', params: [createdByUserId] },
          overall: { sql: ' AND overall_status.created_by = ?', params: [createdByUserId] }
        };
      }

      // default no filter
      return {
        plain: { sql: '', params: [] },
        jobs: { sql: '', params: [] },
        overall: { sql: '', params: [] }
      };
    };


    const owner = buildOwnerFragments(); // owner.plain, owner.jobs, owner.overall
    // isSuperAdmin = false;

    
    console.log("sql",owner.jobs.sql);

    console.log("params",owner.jobs.params);

    // --- run queries in parallel, using the table-qualified fragments where needed ---
    const [
      [companyCount],
      [activeCompanyCount],
      [jobsCount],
      [candidatesCount],
      [filteredCount],
      [failed],
      [recentJobs],
      [lastSeavenDaysCandidates],
      [lastSeavenDaysJobs],
      [lastSeavenDaysPassedCandidates],
      [overviewJobs],
      [overviewCandidates],
      [overviewCallDoneCandidates],
      [overviewFailedCandidates],
      [overviewPassCandidates]
    ] = await Promise.all([
      db.query('SELECT COUNT(*) AS count FROM companies'),
      db.query('SELECT COUNT(*) AS count FROM companies WHERE `is_verified` = 1'),

      // 1) jobsCount (jobs table)
      db.query(
        isSuperAdmin
          ? 'SELECT COUNT(*) AS count FROM jobs WHERE 1=1' + owner.jobs.sql
          : 'SELECT COUNT(*) AS count FROM jobs WHERE 1=1' + owner.jobs.sql,
        isSuperAdmin ? owner.jobs.params : owner.jobs.params
      ),

      // 2) candidatesCount (overall_status)
      db.query(
        isSuperAdmin
          ? 'SELECT COUNT(*) AS count FROM overall_status WHERE 1=1' + owner.overall.sql
          : 'SELECT COUNT(*) AS count FROM overall_status WHERE 1=1' + owner.overall.sql,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      ),

      // 3) filteredCount (Passed) — overall_status
      db.query(
        isSuperAdmin
          ? "SELECT COUNT(*) AS count FROM overall_status WHERE result_status = 'Passed' " + owner.overall.sql
          : "SELECT COUNT(*) AS count FROM overall_status WHERE result_status = 'Passed' " + owner.overall.sql,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      ),

      // 4) failed (overall_status)
      db.query(
        isSuperAdmin
          ? "SELECT COUNT(*) AS count FROM overall_status WHERE result_status = 'Failed' " + owner.overall.sql
          : "SELECT COUNT(*) AS count FROM overall_status WHERE result_status = 'Failed' " + owner.overall.sql,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      ),

      // 5) recentJobs (jobs join overall_status) — use jobs-qualified fragment
      db.query(
        isSuperAdmin
          ? `
            SELECT jobs.job_id, jobs.title, jobs.created_at, COUNT(overall_status.id) AS total_candidates
            FROM jobs
            LEFT JOIN overall_status ON jobs.job_id = overall_status.job_id
            WHERE 1=1 ${owner.jobs.sql}
            GROUP BY jobs.job_id, jobs.title, jobs.created_at
            ORDER BY jobs.created_at DESC
            LIMIT 5
          `
          : `
            SELECT jobs.job_id, jobs.title, jobs.created_at, COUNT(overall_status.id) AS total_candidates
            FROM jobs
            LEFT JOIN overall_status ON jobs.job_id = overall_status.job_id
            WHERE 1=1 ${owner.jobs.sql}
            GROUP BY jobs.job_id, jobs.title, jobs.created_at
            ORDER BY jobs.created_at DESC
            LIMIT 5
          `,
        isSuperAdmin ? owner.jobs.params : owner.jobs.params
      ),

      // 6) lastSeavenDaysCandidates (overall_status per day) — overall-qualified
      db.query(
        `
        SELECT days.day, DAYNAME(days.day) AS day_name, 
               COALESCE(COUNT(overall_status.created_at), 0) AS count 
        FROM (
          SELECT CURDATE() - INTERVAL n DAY AS day 
          FROM (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL 
                SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) AS numbers
        ) AS days 
        LEFT JOIN overall_status 
          ON DATE(overall_status.created_at) = days.day
        WHERE 1=1 ${owner.overall.sql}
        GROUP BY days.day 
        ORDER BY days.day ASC
      `,
        owner.overall.params
      ),

      // 7) lastSeavenDaysJobs (jobs per day) — jobs-qualified
      db.query(
        `
        SELECT days.day, DAYNAME(days.day) AS day_name, 
               COALESCE(COUNT(jobs.created_at), 0) AS job_count 
        FROM (
          SELECT CURDATE() - INTERVAL n DAY AS day 
          FROM (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL 
                SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) AS numbers
        ) AS days 
        LEFT JOIN jobs 
          ON DATE(jobs.created_at) = days.day
        WHERE 1=1 ${owner.jobs.sql}
        GROUP BY days.day 
        ORDER BY days.day ASC
      `,
        owner.jobs.params
      ),

      // 8) lastSeavenDaysPassedCandidates (overall_status passed per day) — overall-qualified
      db.query(
        `
        SELECT days.day, DAYNAME(days.day) AS day_name, 
               COALESCE(COUNT(overall_status.created_at), 0) AS count 
        FROM (
          SELECT CURDATE() - INTERVAL n DAY AS day 
          FROM (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL 
                SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) AS numbers
        ) AS days 
        LEFT JOIN overall_status 
          ON DATE(overall_status.created_at) = days.day 
          AND overall_status.result_status = 'Passed'
        WHERE 1=1 ${owner.overall.sql}
        GROUP BY days.day 
        ORDER BY days.day ASC
      `,
        owner.overall.params
      ),

      // 9) overviewJobs (this month) — jobs-qualified
      db.query(
        `
        SELECT COUNT(*) AS count
        FROM jobs
        WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
          ${isSuperAdmin ? owner.jobs.sql : owner.jobs.sql}
      `,
        isSuperAdmin ? owner.jobs.params : owner.jobs.params
      ),

      // 10) overviewCandidates (this month) — overall-qualified
      db.query(
        `
        SELECT COUNT(*) AS count
        FROM overall_status
        WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
          ${isSuperAdmin ? owner.overall.sql : owner.overall.sql}
      `,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      ),

      // 11) overviewCallDoneCandidates (sid not null) — overall-qualified
      db.query(
        `
        SELECT COUNT(*) AS count
        FROM overall_status
        WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') 
          AND sid IS NOT NULL AND sid != ''
          ${isSuperAdmin ? owner.overall.sql : owner.overall.sql}
      `,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      ),

      // 12) overviewFailedCandidates — overall-qualified
      db.query(
        `
        SELECT COUNT(*) AS count
        FROM overall_status
        WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
          AND result_status = 'Failed'
          ${isSuperAdmin ? owner.overall.sql : owner.overall.sql}
      `,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      ),

      // 13) overviewPassCandidates — overall-qualified
      db.query(
        `
        SELECT COUNT(*) AS count
        FROM overall_status
        WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
          AND result_status = 'Passed'
          ${isSuperAdmin ? owner.overall.sql : owner.overall.sql}
      `,
        isSuperAdmin ? owner.overall.params : owner.overall.params
      )
    ]);

    // --- prepare stats and render ---
    const stats = {
      company: companyCount[0].count,
      activeCompany: activeCompanyCount[0].count,
      jobs: jobsCount[0].count,
      candidates: candidatesCount[0].count,
      filtered: filteredCount[0].count,
      fail: failed[0].count,
      callOverviewJobs: overviewJobs[0].count,
      callOverviewCandidates: overviewCandidates[0].count,
      callOverviewCallDoneCandidates: overviewCallDoneCandidates[0].count,
      calloverviewFailedCandidates: overviewFailedCandidates[0].count,
      calloverviewPassCandidates: overviewPassCandidates[0].count,
    };

    const options = { year: 'numeric', month: 'long' };
    const currentMonthYear = new Date().toLocaleDateString('en-US', options);
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at ASC`);

   
    const selectedCompanyId = req.session.selectedCompanyId || companyIdToFilter;

    res.render('authpages/dashboard', {
      email: req.session.email,
      stats,
      recentJobs,
      lastSeavenDaysJobs,
      lastSeavenDaysCandidates,
      lastSeavenDaysPassedCandidates,
      currentPath: req.originalUrl,
      currentMonthYear,
      companies,
      selectedCompanyId
    });

  } catch (err) {
    console.error('Error loading dashboard:', err);
    res.status(500).send('Error loading dashboard');
  }
};

// Logout
const logout = (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }
    res.redirect('/login');
  });
};

const getLinkedInPosts = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {
    const [posts] = await db.query(`
      SELECT * FROM linkedin_posts ORDER BY created_at DESC`);

    res.render('authpages/linkedIn-posts', {
      email: req.session.email,
      posts,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching jobs:', err);
    res.status(500).send('Error loading posts page');
  }
};

const getLinkedInPostByID = async (req, res) => {
  const postId = req.params.id;
  
    try {
      const [rows] = await db.query(`
        SELECT * FROM linkedin_posts WHERE id = ?
      `, [postId]);
  
      const post = rows[0];
  
      if (!post) {
        return res.status(404).send('Post not found');
      }
  
      res.render('authpages/linkedIn-posts-details', {
        email: req.session.email,
        post,
        currentPath: req.originalUrl
      });
  
    } catch (err) {
      console.error('Error fetching post details:', err);
      res.status(500).send('Error loading post details');
    }
}

const adminList = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {
    const roleId = parseInt(req.session.role_id, 10);
    const sessionUserId = req.session.user_id ? parseInt(req.session.user_id, 10) : null;

    let companyIdToFilter = null;

    let query = `
      SELECT 
        admins.*, 
        roles.name AS role_name, 
        companies.name AS company_name
      FROM admins
      LEFT JOIN roles ON admins.role_id = roles.id
      LEFT JOIN companies ON admins.company_id = companies.id
    `;
    const params = [];


    if (roleId === 1) {
      //superadmin
      if (req.session.company_id !== undefined && req.session.company_id !== null) {
        companyIdToFilter = Number(req.session.company_id);
      } else {
        companyIdToFilter = 0; // default
      }

      if(req.session.company_id == 1){
          query += ` WHERE admins.company_id IS NULL OR admins.company_id = ?`;
      }else{

        query += ` WHERE admins.company_id = ?`;

      }
      params.push(companyIdToFilter);

    }else if(roleId === 2){
        //admin
        companyIdToFilter = Number(req.session.company_id);
        query += ` WHERE admins.company_id = ?`;
        params.push(companyIdToFilter);

    }else {
      //normal user
      const [adminRow] = await db.query(
        'SELECT company_id FROM admins WHERE id = ? LIMIT 1',
        [sessionUserId]
      );

      if (adminRow.length > 0 && adminRow[0].company_id) {
        companyIdToFilter = Number(adminRow[0].company_id);
      } else {
        companyIdToFilter = 1; // default fallback
      }

      query += ` WHERE admins.created_by = ?`;
      params.push(sessionUserId);

      
    }
    
    query += ` ORDER BY admins.created_at DESC`;

    console.log(query);

    const [admins] = await db.query(query, params);
    
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at ASC`);

    const selectedCompanyId = req.session.selectedCompanyId || companyIdToFilter;

    res.render('authpages/admin-list', {
      email: req.session.email,
      admins,
      companies,
      selectedCompanyId,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching Users:', err);
    res.status(500).send('Error loading User page');
  }
};

const addAdmin = async (req, res) => {
  if (!req.session.isLoggedIn) return res.redirect('/');

  try {
    let roleId = req.session.role_id;
    if(parseInt(roleId) == 1){
      var [roles] = await db.query(`SELECT * FROM roles WHERE name NOT IN ('superAdmin') ORDER BY created_at DESC`);
    }else{
      var [roles] = await db.query(`SELECT * FROM roles WHERE name NOT IN ('admin', 'superAdmin') ORDER BY created_at DESC`);
    }
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at DESC`);

    res.render('authpages/admin-add', {
      email: req.session.email,
      roles,
      companies,
      currentPath: req.originalUrl
    });

  } catch (err) {
    console.error('Error fetching Users:', err);
    res.status(500).send('Error loading Users page');
  }
};

// View single admin
const viewAdmin = async (req, res) => {
  try {
    db.query("SELECT * FROM admins WHERE id = ?", [req.params.id], (err, rows) => {
    if (err || rows.length === 0) return res.status(404).send("Admin not found");
    res.render("authpages/admin-view", { admin: rows[0] });
  });
  } catch (error) {
    res.status(500).send("Error viewing User");
  }
};


// Create admin
const createAdmin = async (req, res) => {
  try {
    const {name,email,role_id} = req.body;
    var companyId = '';
    var createdById = '';
    let roleId = req.session.role_id;
    
    createdById = req.session.user_id;
    companyId = req.session.company_id;

    await db.execute('INSERT INTO admins (email,name,role_id,company_id,created_by,created_at) VALUES (?,?,?,?,?, NOW())', [email,name,role_id,companyId,createdById]);
    req.flash('success_msg', 'User added successful!');
    res.redirect('/admin');
  } catch (error) {
    console.log(error);
    req.flash('error_msg', 'Error creating User!');
   
  }
};

// Show Edit form
const editAdminForm = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('SELECT * FROM admins WHERE id = ?', [id]);
     let roleId = req.session.role_id;
    if(parseInt(roleId) == 1){
      var [roles] = await db.query(`SELECT * FROM roles WHERE name NOT IN ('superAdmin') ORDER BY created_at DESC`);
    }else{
      var [roles] = await db.query(`SELECT * FROM roles WHERE name NOT IN ('admin', 'superAdmin') ORDER BY created_at DESC`);
    }
    // const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at DESC`);
    console.log(id);
    const admin = result[0];
    console.log(admin);
    res.render('authpages/admin-edit', {
      email: req.session.email,
      admin,
      roles,
      // companies,
      currentPath: req.originalUrl
    });

  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error loading edit form!');
  }
};

// Update admin
const updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const {name,email,role_id} = req.body;
    console.log(name);
    console.log(email);
    console.log(role_id);
    const sql = `UPDATE admins SET email = ?, name = ?, role_id = ? WHERE id = ?`;
    const [result] = await db.execute(sql, [email, name, role_id, id]);
    if (result.affectedRows === 0) {
      console.error('Admin not found');
      res.redirect('/admin');
    }
    req.flash('success_msg', 'Recruiter updated successfully!');
    res.redirect('/admin');
  } catch (error) {
    console.error(error);
    req.flash('error_msg', 'Error in updating Recruiter!');
    res.redirect('/admin');
  }
};

// Delete admin
const deleteAdmin = async (req, res) => {
  try {
    const adminId = req.params.id;
    await db.query('DELETE FROM admins WHERE id = ?', [adminId]);
    console.log(adminId);
    res.redirect('/admin');
  } catch (error) {
    console.error(error);
    res.redirect('/admin');
  }
};

// Render login page
const aiChatInbox = async (req, res) => {

      const roleId = parseInt(req.session.role_id, 10);
    const sessionUserId = req.session.user_id ? parseInt(req.session.user_id, 10) : null;

    let companyIdToFilter = null;

    // ------------------------------
    // SUPER ADMIN
    // ------------------------------
    if (roleId === 1) {
      if (req.session.company_id !== undefined && req.session.company_id !== null) {
        companyIdToFilter = Number(req.session.company_id);
      } else {
        companyIdToFilter = 0; // default
      }
    } 
    // ------------------------------
    // NORMAL ADMIN
    // ------------------------------
    else {
      const [adminRow] = await db.query(
        'SELECT company_id FROM admins WHERE id = ? LIMIT 1',
        [sessionUserId]
      );

      if (adminRow.length > 0 && adminRow[0].company_id) {
        companyIdToFilter = Number(adminRow[0].company_id);
      } else {
        companyIdToFilter = 1; // default fallback
      }
    }

    console.log("Final company filter used:", companyIdToFilter);
     console.log("Final company req.session.selectedCompanyId used:", req.session.selectedCompanyId);
    const [companies] = await db.query(`SELECT * FROM companies ORDER BY created_at ASC`);
  const selectedCompanyId = req.session.selectedCompanyId || companyIdToFilter;

  res.render('authpages/ai-chatInbox', {
      companies,
      selectedCompanyId,
      currentPath: req.originalUrl
    });
};

const jdHistory = async (req, res) => {
  try {
    const sessionUserId = req.session.user_id
      ? parseInt(req.session.user_id, 10)
      : null;

    if (!sessionUserId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const [rows] = await db.query(`
      SELECT t2.job_id,
       t2.title,
       t2.enhanced_description,
       t2.created_at AS latest_created_at
        FROM (
            -- Step 2: latest record per TITLE (secondary priority)
            SELECT t1.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY t1.title
                    ORDER BY t1.created_at DESC
                  ) AS rn_title
            FROM (
                -- Step 1: latest record per JOB_ID (primary priority)
                SELECT j.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY j.job_id
                        ORDER BY j.created_at DESC
                      ) AS rn_job
                FROM jobs j
                WHERE j.created_by = ?
                  AND j.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            ) t1
            WHERE t1.rn_job = 1
        ) t2
        WHERE t2.rn_title = 1
        ORDER BY t2.created_at DESC;
    `, [sessionUserId]);
    

    return res.json({
      success: true,
      data: rows
    });

  } catch (error) {
    console.error('JD history fetch error:', error);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong'
    });
  }
};



const getpermissions = async (req, res) => {
  console.log("is permissions fetched",req.session.role_id);
  const userRole = req.session.role_id;
  const { ac } = await import("./accesscontrol.js");
  const permissions = {
        canReadUser: ac.can(userRole).read("user").granted,
        canCreateUser: ac.can(userRole).create("user").granted,
        canUpdateUser: ac.can(userRole).update("user").granted,
        canDeleteUser: ac.can(userRole).delete("user").granted
    };
  res.json({ role: userRole, permissions });

  // if (!req.session.role_id) return res.status(401).json({ message: "Not logged in" });
  // const permissions = req.session.permissions || [];
  // res.json({ permissions });

}

const verifyLink = async (req, res) => {
  const { token } = req.query;
  if (!token) return res.send('Invalid token');

  try {
    // get token record
    const [rows] = await db.query(
      `SELECT * FROM email_tokens WHERE token = ? LIMIT 1`,
      [token]
    );

    if (!rows || rows.length === 0) {
      return res.send('Invalid or expired token');
    }

    const record = rows[0];

    // check expiry
    if (new Date(record.expires_at) < new Date()) {
      // cleanup expired token
      await db.execute(`DELETE FROM email_tokens WHERE token = ?`, [token]);
      return res.send('Link expired');
    }

    // token valid — render page to enter the verification code
    // make sure your form posts to /verify-code and includes a hidden input for token
    return res.render('authpages/enter-verification-code', {
      email: record.email,   // optionally show email to user
      token: record.token,
      currentPath: req.originalUrl
    });
  } catch (err) {
    console.error('Error verifying token:', err);
    return res.status(500).send('Error verifying token');
  } 
};

const submitVerificationCode = async (req, res) => {
  const { token, code } = req.body;
  if (!token || !code) {
    return res.status(400).send('Token and code are required');
  }

  try {
    // find the token record matching both token and code
    const [rows] = await db.query(
      `SELECT * FROM email_tokens WHERE token = ? AND code = ? LIMIT 1`,
      [token, code]
    );

    if (!rows || rows.length === 0) {
      return res.status(400).render('authpages/enter-verification-code', {
        error: 'Invalid code. Please try again.',
        token,
        currentPath: req.originalUrl
      });
    }

    const record = rows[0];

    // check expiry
    if (new Date(record.expires_at) < new Date()) {
      // cleanup expired tokens for this email (optional)
      await db.execute(`DELETE FROM email_tokens WHERE token = ? OR email = ?`, [token, record.email]);
      return res.status(400).render('authpages/enter-verification-code', {
        error: 'Code expired. Please request a new verification email.',
        token: null,
        currentPath: req.originalUrl
      });
    }

    // mark user verified (insert or update)
    await db.execute(
      `UPDATE companies 
      SET is_verified = 1, 
          verified_at = NOW() 
      WHERE email = ?`,
      [record.email]
    );

    // cleanup tokens for this email (remove any outstanding tokens/codes)
    await db.execute(`DELETE FROM email_tokens WHERE email = ?`, [record.email]);

    // render success page
    return res.render('authpages/verification-success', {
      email: record.email,
      currentPath: req.originalUrl
    });
  } catch (err) {
    console.error('Error verifying code:', err);
    return res.status(500).send('Error verifying code');
  } 
};

// ✅ Export as a single default object
export default {
  getLanding,
  getLogin,
  sendOTP,
  verifyOTP,
  getDashboard,
  getSuperAdminDashboard,
  logout,
  getLinkedInPosts,
  getLinkedInPostByID,
  adminList,
  addAdmin,
  viewAdmin,
  createAdmin,
  editAdminForm,
  updateAdmin,
  deleteAdmin,
  aiChatInbox,
  getpermissions,
  verifyLink,
  submitVerificationCode,
  jdHistory
};
