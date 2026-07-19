import db from '../config/db.js';
import { isValidApiBearerToken } from '../config/env.js';
import {sendOtpEmail} from '../mailer.js';
import { v4 as uuidv4 } from 'uuid';
import { getOpenAI } from '../config/openaiClient.js';
import dotenv from 'dotenv';
dotenv.config();

const sessions = {};
let otpMap = new Map();
const openai = getOpenAI();
// check email id is exists 
const checkEmail = async (req, res) => {

    const { email } = req.body;
    const [rows] = await db.execute(`SELECT * FROM admins WHERE email = ?`, [email]);

    if (rows.length === 0) {
        return res.status(500).json({ message: 'Email Id not found', email });
    }

    return res.status(200).json({ message: 'Email ID received', email });

};

// Save OTP
const saveOtp = async (req, res) => {

    const { email, otp } = req.body;

    const [rows] = await db.execute(`SELECT * FROM admins WHERE email = ?`, [email]);

    if (rows.length === 0) {
        return res.status(500).json({ message: 'Email Id not found', email });
    }

    console.log(otp);
    
    await db.execute('UPDATE admins SET otp = ? WHERE email = ?', [otp, email]);

    otpMap.set(email, otp);
    sendOtpEmail(email, otp,'User');

    console.log('OTP inserted successfully');

    return res.status(200).json({ message: 'OTP inserted', email });

};

//Verify otp
const verifyOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;

        const [rows] = await db.execute(
            'SELECT * FROM admins WHERE email = ? AND otp = ?',
            [email, otp]
        );

        if (rows.length > 0) {
            console.log('OTP exists for the email.');
            return res.status(200).json({ message: 'OTP is valid', email });
        } else {
            console.log('OTP does not match for the email.');
            return res.status(500).json({ message: 'Invalid OTP or email', email });
        }
    } catch (error) {
        console.error('Database error:', error);
        return res.status(500).json({ message: 'Database error' });
    }
};

//generate key for authrization
const fetchAuthrizationKey = async (req, res) => {

    const secretKey = process.env.API_KEY;

    const encodedKey = Buffer.from(secretKey).toString('base64');
    // encodedKey = 'c3VwZXJzZWNyZXQxMjM='
    console.log(encodedKey);

    return res.status(200).json({ message: 'here is the key', encodedKey });

};


// Dashboard
const getDashboard = async (req, res) => {
    try {

        const [
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
      `), db.query(`
  SELECT COUNT(*) AS count
  FROM jobs
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
`), db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
`)
            , db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') AND sid IS NOT NULL
  AND sid != ''
`), db.query(`
  SELECT COUNT(*) AS count
  FROM overall_status
  WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
  AND created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND result_status = 'Failed'
`), db.query(`
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

        return res.status(200).json({ stats, recentJobs, lastSeavenDaysJobs, lastSeavenDaysCandidates, lastSeavenDaysPassedCandidates });

    } catch (err) {
        console.error('Error loading dashboard:', err);
        return res.status(500).json('Error loading dashboard');
    }
};

const fetchUsers = async (req, res) => {


    try {
        const [admins] = await db.query(`SELECT * FROM admins ORDER BY created_at DESC`);

        if (admins.length > 0) {
            console.log('user fetched');
            return res.status(200).json({ admins });
        } else {
            console.log('user not found.');
            return res.status(500).json({ message: 'user not found' });
        }
    } catch (err) {
        console.error('Error fetching Users:', err);
        res.status(500).json('Error loading User page');
    }
};

const fetchJobs = async (req, res) => {

    try {
        const id = req.query.id;

        if (id) {
            const [rows] = await db.query(`
                SELECT * FROM jobs WHERE id = ?
            `, [id]);

            const job = rows[0];

            if (!job) {
                return res.status(404).send('Job not found');
            }
            // You can query the database or do something with the jobId here
            return res.status(200).json({ job });
        }

        const [jobs] = await db.query(`
            SELECT jobs.id, jobs.job_id, jobs.title,jobs.question_count,jobs.experience,jobs.description,jobs.questions,jobs.numbers, jobs.created_at, admins.name 
            FROM jobs 
            LEFT JOIN admins ON jobs.user_id = admins.id 
            ORDER BY jobs.id DESC`);

        return res.status(200).json({ jobs });
    } catch (err) {
        console.error('Error fetching jobs:', err);
        res.status(500).json('Error loading jobs page');
    }
};

const fetchCandidates = async (req, res) => {

    try {
        let table = '';
        let view = '';
        table = 'overall_status';
        const jobId = req.query.job_id;

        if (jobId) {

            const [row] = await db.query(`
            SELECT os.*,j.title,a.name FROM overall_status os LEFT JOIN jobs j ON os.job_id = j.job_id LEFT JOIN admins a ON j.user_id = a.id WHERE os.job_id = ? ORDER BY os.id DESC`, [jobId]);

            // const [rows] = await db.query(`SELECT * FROM ${table} WHERE job_id = ?`, [jobId]);

            const candidate = row[0];

            if (!candidate) {
                return res.status(404).send('candidate not found');
            }
            // You can query the database or do something with the jobId here
            return res.status(200).json({ row });
        }

        const [candidates] = await db.query(`
            SELECT os.*,j.title,a.name FROM overall_status os LEFT JOIN jobs j ON os.job_id = j.job_id LEFT JOIN admins a ON j.user_id = a.id ORDER BY os.id DESC`);

        return res.status(200).json({ candidates });

    } catch (err) {
        console.error('Error fetching candidates:', err);
        res.status(500).json('Error loading candidates page');
    }
};

const fetchUserFeedback = async (req, res) => {

    const { limit = 10, offset = 0 } = req.query;

    try {
       
        const [rows] = await db.query(
          `SELECT * FROM overall_status 
          ORDER BY id DESC 
          LIMIT ? OFFSET ?`,
          [parseInt(limit), parseInt(offset)]
        );

        const feedback = rows;

        if (!feedback) {
            return res.status(404).send('feedback not found');
        }
        
        return res.status(200).json({ feedback });

    } catch (err) {
        console.error('Error fetching feedback details:', err);
        res.status(500).send('Error loading feedback details');
    }
}

const fetchUserFeedbackById = async (req, res) => {
  
  const { id } = req.params;

    try {
      
        const [rows] = await db.query(
          `SELECT * FROM overall_status WHERE id = ?`,[id]
        );

        const feedback = rows;

        if (!feedback) {
            return res.status(404).send('feedback not found');
        }

        return res.status(200).json({ feedback });

    } catch (err) {
        console.error('Error fetching feedback details:', err);
        res.status(500).send('Error loading feedback details');
    }
}

const initiateCallDisabled = async (_req, res) => {
  return res.status(410).json({
    error: 'Telephony interviews are no longer supported.',
    message: 'Use Mission Hire browser video scheduling or POST /api/v1/schedule/video-interview.',
  });
};

function parseJobDetails(message) {
  const blocks = [];
  let current = { title: null, description: null, experience: null, numQuestions: null, contacts: [] };

  // Match all fields no matter if in same line or multiple lines
  const profileMatch = message.match(/Job Profile\s*:\s*([^:]+?)(?=Job Description|Experience Required|Number of Questions|List of Contacts|$)/i);
  const descMatch = message.match(/Job Description\s*:\s*([^:]+?)(?=Experience Required|Number of Questions|List of Contacts|$)/i);
  const expMatch = message.match(/Experience Required\s*:\s*([^:]+?)(?=Number of Questions|List of Contacts|$)/i);
  const numMatch = message.match(/Number of Questions to Ask\s*:\s*(\d+)/i);
  const contactMatch = message.match(/List of Contacts\s*:\s*(.*)$/i);

  current.title = profileMatch ? profileMatch[1].trim() : null;
  current.description = descMatch ? descMatch[1].trim() : null;
  current.experience = expMatch ? expMatch[1].trim() : null;
  current.numQuestions = numMatch ? parseInt(numMatch[1]) : null;
  current.contacts = contactMatch && contactMatch[1]
    ? contactMatch[1].split(/[,;\s]+/).map(c => c.replace(/[^\d+]/g, '').trim()).filter(c => c.length > 0)
    : [];

  blocks.push(current);
  return blocks;
}

function validateJobData(blocks) {
  const missing = [];

  blocks.forEach((block, idx) => {
    const missingFields = [];
    if (!block.title) missingFields.push("Job Profile");
    if (!block.description) missingFields.push("Job Description");
    if (!block.experience) missingFields.push("Experience Required");
    if (!block.numQuestions) missingFields.push("Number of Questions to Ask");
    if (!block.contacts || block.contacts.length === 0) missingFields.push("List of Contacts");

    if (missingFields.length > 0) {
      missing.push(`${missingFields.join(", ")}`);
    }
  });

  return missing;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeNumbers(contactList) {
  const valid = [];
  const invalid = [];
  for (let raw of contactList) {
    const n = raw.replace(/\s+/g, '').replace(/[^+\d]/g, '');
    if (!n) { invalid.push(raw); continue; }
    if (n.startsWith('+')) {
      valid.push(n);
    } else if (n.length === 12 && n.startsWith('91')) {
      valid.push('+' + n);
    } else if (n.length === 10) {
      valid.push('+91' + n);
    } else {
      invalid.push(raw);
    }
  }
  return { valid, invalid };
}

export async function generateQuestionsAI(title, experience, numQuestions = 5, description) {
  const prompt = `
Generate exactly 25 interview questions for a ${title} role.
Candidate should have at least ${experience} years of experience.
Focus on the following job description and required skills: ${description}.
Return ONLY a valid JSON array of strings (questions only), nothing else.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0
  });

  let raw = response.choices?.[0]?.message?.content?.trim() || "[]";

  // Remove code fences if any
  raw = raw.replace(/```json|```/gi, "").trim();

  // Remove problematic trailing commas
  raw = raw.replace(/,(\s*[\]\}])/g, "$1");

  // Replace smart quotes with normal quotes
  raw = raw.replace(/[“”]/g, '"');

  // Remove newlines inside strings
  raw = raw.replace(/\r?\n/g, " ");

  // Extract the first array in case GPT returns extra text
  const match = raw.match(/\[.*\]/s);
  if (!match) return [];

  raw = match[0];

  // ✅ Try JSON.parse safely
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.questions && Array.isArray(parsed.questions)) return parsed.questions;
    return [];
  } catch {
    // 🔹 Last-resort manual parse: split by "," and clean quotes
    return raw
      .slice(1, -1) // remove [ ]
      .split(/","|", "/)
      .map(q => q.replace(/^"+|"+$/g, "").trim())
      .filter(q => q.length > 0);
  }
}

async function generateQuestionsAIFallback(title, experience, count) {
  return Array.from({ length: count }, (_, i) => `${title} - Question ${i+1} (${experience})`);
}

function safeJsonParse(input, fallback = null) {
  try {
    if (typeof input !== 'string') return fallback;
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function truncateForPrompt(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatInterviewQuestionForVerdict(raw) {
  const qObj = safeJsonParse(raw);
  if (qObj && typeof qObj === 'object') {
    const t = qObj.q1 || qObj.question || qObj.text;
    if (t) return truncateForPrompt(String(t), 650);
    return truncateForPrompt(JSON.stringify(qObj), 650);
  }
  return truncateForPrompt(String(raw ?? ''), 650);
}

function formatInterviewAnswerForVerdict(raw) {
  const aObj = safeJsonParse(raw);
  if (aObj && typeof aObj === 'object') {
    const t = aObj.answer || aObj.text || aObj.user_answer;
    if (t) return truncateForPrompt(String(t), 450);
    return truncateForPrompt(JSON.stringify(aObj), 450);
  }
  return truncateForPrompt(String(raw ?? ''), 450);
}

/** @param {unknown} raw */
function parseJobQuestionsForVerdict(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

/** Stable sort by `order` when present; otherwise preserve array order. */
function normalizeJobQuestionsForVerdict(questions) {
  const arr = Array.isArray(questions) ? questions : [];
  const tagged = arr.map((q, idx) => ({ q, idx }));
  tagged.sort((a, b) => {
    const ao =
      a.q && typeof a.q === 'object' && Number.isFinite(Number(a.q.order))
        ? Number(a.q.order)
        : a.idx + 1;
    const bo =
      b.q && typeof b.q === 'object' && Number.isFinite(Number(b.q.order))
        ? Number(b.q.order)
        : b.idx + 1;
    if (ao !== bo) return ao - bo;
    return a.idx - b.idx;
  });
  return tagged.map((x) => x.q);
}

/** @param {unknown} q */
function skillCategoryFromJobQuestionEntry(q) {
  if (typeof q === 'string') return 'general';
  if (!q || typeof q !== 'object') return 'general';
  const c = q.category != null && String(q.category).trim() ? String(q.category).trim() : '';
  if (c) return c;
  const s = q.skill != null && String(q.skill).trim() ? String(q.skill).trim() : '';
  return s || 'general';
}

/** @param {unknown} q */
function plannedQuestionTextForVerdict(q) {
  if (typeof q === 'string') return String(q).trim();
  if (q && typeof q === 'object') {
    const t = String(q.question ?? q.text ?? '').trim();
    return t;
  }
  return '';
}

function buildInterviewQuestionPlanBlock(normalizedQuestions) {
  if (!normalizedQuestions.length) {
    return '(No interview question plan with categories was found on the job record; infer skill axes only from the per-question rows below.)';
  }
  const lines = [];
  normalizedQuestions.forEach((q, i) => {
    const n = i + 1;
    const cat = skillCategoryFromJobQuestionEntry(q);
    const req =
      q && typeof q === 'object' && q.required === true
        ? 'true'
        : q && typeof q === 'object' && q.required === false
          ? 'false'
          : 'unknown';
    const ord =
      q && typeof q === 'object' && q.order != null && String(q.order).trim()
        ? String(q.order).trim()
        : String(n);
    const pq = truncateForPrompt(plannedQuestionTextForVerdict(q), 400);
    lines.push(`Planned Q${n} (order=${ord}) | skill_category: ${cat} | required: ${req} | question: ${pq}`);
  });
  return lines.join('\n');
}

function distinctSkillCategoriesFromJobQuestions(normalizedQuestions) {
  const set = new Set();
  normalizedQuestions.forEach((q) => {
    set.add(skillCategoryFromJobQuestionEntry(q));
  });
  return [...set].sort().join(', ') || 'general';
}

const MISSION_VERDICT_SYSTEM_PROMPT = `You are Mission, an expert hiring and L&D assistant for Three Sixty Degree Cloud. You write concise, professional summaries for recruiters and hiring managers.

You will receive structured data from a completed candidate screening (job interview or training assessment): context, overall outcome fields, optional aggregate scores (JSON), and per-question scores with AI feedback snippets.

Rules:
- Write in clear English. No markdown. Do not use bullet characters inside the verdict paragraph.
- mission_verdict: 2–4 short paragraphs (about 120–400 words total). Cover overall fit, strongest signals, main gaps or risks, and a clear stance (e.g. recommend to proceed / lean recommend / not recommended / needs follow-up) without legal guarantees. Ground everything in the provided scores and feedback.
- mission_recommendations: array of strings — include **as many distinct, actionable items as the evidence supports** (minimum **3**). If the screening surface is small, stay near 3–5; if there are many separate gaps, strengths, or follow-ups implied by the feedback, include more (hard cap **12**). Each item one sentence, actionable (training, pairing, next interview focus, documentation to request). No numbering inside the strings—the client UI will number them.
- For **job interviews**, treat each row's **skill_category** (from the interview question plan) as the skill axis being evaluated. Organize your verdict and recommendations around those categories (e.g. technical, problem_solving, architecture). **Do not** lean on job title or job-description-style marketing copy—they are intentionally omitted from the payload.
- If many questions lack scores or feedback, acknowledge uncertainty briefly and recommend follow-up rather than a strong hire/no-hire.
- Do not invent answers that are not supported by the excerpts.

Output: return ONLY valid JSON with this exact shape (no text outside JSON). mission_recommendations length may vary (minimum 3, at most 12 strings):
{"mission_verdict":"<string>","mission_recommendations":["<string>","<string>"]}`;

async function fetchJobContextForVerdict(jobId) {
  if (!jobId) return null;
  try {
    const [rows] = await db.query(
      `SELECT questions FROM jobs WHERE job_id = ? ORDER BY id DESC LIMIT 1`,
      [jobId]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function generateMissionVerdictAndRecommendationsInterview(overall, feedbackRows, jobRow) {
  const empty = { mission_verdict: null, mission_recommendations: [] };
  if (!feedbackRows?.length) return empty;
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn('[user-call-summary] OPENAI_API_KEY missing; skipping Mission verdict');
    return empty;
  }

  const totalScoreStr =
    typeof overall.total_score === 'string'
      ? overall.total_score
      : JSON.stringify(overall.total_score ?? {});

  const normalizedPlan = normalizeJobQuestionsForVerdict(parseJobQuestionsForVerdict(jobRow?.questions));
  const planBlock = buildInterviewQuestionPlanBlock(normalizedPlan);
  const distinctCats = distinctSkillCategoriesFromJobQuestions(normalizedPlan);

  let perQuestion = '';
  feedbackRows.slice(0, 35).forEach((row, i) => {
    const cat =
      i < normalizedPlan.length
        ? skillCategoryFromJobQuestionEntry(normalizedPlan[i])
        : 'unmatched_or_extra';
    perQuestion += `Q${i + 1}:
  skill_category: ${cat}
  question: ${formatInterviewQuestionForVerdict(row.question)}
  score: ${Number(row.score || 0)}
  ai_feedback: ${truncateForPrompt(row.feedback, 800)}
  answer_excerpt: ${formatInterviewAnswerForVerdict(row.user_answer)}

`;
  });

  const userContent = `Screening type: JOB INTERVIEW

REFERENCE
- job_id: ${overall.job_id}

INTERVIEW_QUESTION_PLAN (skill categories — authoritative axes for what was evaluated)
${planBlock}

Distinct skill_categories in this plan: ${distinctCats}

CANDIDATE
- contact: ${overall.contact}
- email: ${overall.user_email || 'unknown'}

CALL OUTCOME
- result_status: ${overall.result_status ?? ''}
- call_status: ${overall.call_status ?? ''}
- total_questions: ${overall.total_questions ?? 0}
- answered_questions: ${overall.answered_questions ?? 0}
- total_score_json: ${truncateForPrompt(totalScoreStr, 4000)}

PER_QUESTION
${perQuestion}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: MISSION_VERDICT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 1400,
    });
    const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    const verdict = typeof parsed.mission_verdict === 'string' ? parsed.mission_verdict.trim() : '';
    const rec = Array.isArray(parsed.mission_recommendations)
      ? parsed.mission_recommendations.map((x) => String(x).trim()).filter(Boolean)
      : [];
    return {
      mission_verdict: verdict || null,
      mission_recommendations: rec.slice(0, 12),
    };
  } catch (e) {
    console.error('[user-call-summary] Mission verdict (interview) failed:', e?.message || e);
    return empty;
  }
}

async function generateMissionVerdictAndRecommendationsAssessment(trainee, responseRows) {
  const empty = { mission_verdict: null, mission_recommendations: [] };
  if (!responseRows?.length) return empty;
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn('[user-call-summary] OPENAI_API_KEY missing; skipping Mission verdict (assessment)');
    return empty;
  }

  let perQuestion = '';
  responseRows.slice(0, 40).forEach((row, i) => {
    perQuestion += `Q${i + 1}:
  question: ${truncateForPrompt(row.question, 700)}
  score_percent: ${Number(row.score_percent || 0)}
  star_rating: ${Number(row.star_rating || 0)}
  ai_feedback: ${truncateForPrompt(row.feedback, 800)}
  answer_excerpt: ${truncateForPrompt(row.trainee_response, 450)}

`;
  });

  const userContent = `Screening type: TRAINING / POSH ASSESSMENT

ASSESSMENT
- assessment_id: ${trainee.assessment_id}
- assessment_title: ${trainee.assessment_title || ''}
- assessment_type: ${trainee.assessment_type || ''}

TRAINEE
- name: ${trainee.full_name || ''}
- contact: ${trainee.phone_number || ''}
- email: ${trainee.email || ''}

CALL OUTCOME
- call_status: ${trainee.call_status ?? ''}

PER_QUESTION
${perQuestion}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: MISSION_VERDICT_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 1400,
    });
    const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    const verdict = typeof parsed.mission_verdict === 'string' ? parsed.mission_verdict.trim() : '';
    const rec = Array.isArray(parsed.mission_recommendations)
      ? parsed.mission_recommendations.map((x) => String(x).trim()).filter(Boolean)
      : [];
    return {
      mission_verdict: verdict || null,
      mission_recommendations: rec.slice(0, 12),
    };
  } catch (e) {
    console.error('[user-call-summary] Mission verdict (assessment) failed:', e?.message || e);
    return empty;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function buildContactVariants(contact = '') {
  const raw = String(contact || '').trim();
  if (!raw) return [];

  const variants = new Set([raw]);
  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly) {
    variants.add(digitsOnly);
    variants.add(`+${digitsOnly}`);
    if (digitsOnly.startsWith('00') && digitsOnly.length > 2) {
      variants.add(`+${digitsOnly.slice(2)}`);
    }
  }

  return Array.from(variants).filter(Boolean);
}

function toAbsoluteUrl(req, path = '') {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  const runtimeBase = host ? `${proto}://${host}` : '';
  const envBase = String(process.env.HOST_URL || '').replace(/\/+$/, '');
  const base = runtimeBase || envBase;
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${String(path || '')}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

function collectPhoneVariantsFromJobNumbers(raw) {
  const out = new Set();
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) {
    raw.forEach((p) => buildContactVariants(String(p)).forEach((x) => out.add(x)));
    return Array.from(out);
  }
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        arr.forEach((p) => buildContactVariants(String(p)).forEach((x) => out.add(x)));
        return Array.from(out);
      }
    } catch (_) {
      /* fall through */
    }
  }
  if (s.includes(',')) {
    s.split(',').forEach((p) => buildContactVariants(p.trim()).forEach((x) => out.add(x)));
    return Array.from(out);
  }
  return buildContactVariants(s);
}

function jobRowMatchesContact(jobRow, contactVariants, email) {
  if (contactVariants.length) {
    const phones = collectPhoneVariantsFromJobNumbers(jobRow?.numbers);
    if (phones.some((p) => contactVariants.includes(p))) return true;
  }
  if (email) {
    let em = jobRow?.emails;
    if (Array.isArray(em)) em = em.filter(Boolean).join(',');
    if (typeof em === 'string') {
      const set = em
        .split(/[;,]/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      if (set.includes(String(email).trim().toLowerCase())) return true;
    }
  }
  return false;
}

function deriveMissionStatusFromJob(jobRow, overallRow) {
  if (overallRow?.call_status) return overallRow.call_status;
  const sc = jobRow?.scheduled_call_status;
  if (sc != null && String(sc).trim() !== '' && String(sc).toLowerCase() !== 'pending') {
    return String(sc).replace(/\s+/g, '_').toLowerCase();
  }
  const utcRaw = jobRow?.scheduled_datetime_utc || jobRow?.scheduled_datetime;
  if (utcRaw) {
    const d = utcRaw instanceof Date ? utcRaw : new Date(String(utcRaw).replace(' ', 'T'));
    if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) return 'scheduled';
  }
  return 'pending';
}

function firstNameFromJobNames(names) {
  if (names == null) return null;
  if (Array.isArray(names)) return names[0] != null ? String(names[0]).trim() : null;
  const s = String(names).trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr[0] != null) return String(arr[0]).trim();
    } catch (_) {
      /* fall through */
    }
  }
  return s.split(',')[0].trim() || null;
}

async function fetchLatestOverallSnapshot(jobId) {
  const [rows] = await db.query(
    `SELECT created_at, result_status, call_status
     FROM overall_status
     WHERE job_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [jobId]
  );
  return rows[0] || null;
}

async function fetchApiCallRowForJobContact(jobId, contactVariants, email) {
  const variants = contactVariants || [];
  if (variants.length) {
    const ph = variants.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT call_id, status, twilio_call_sid, candidate_name, candidate_email, candidate_phone, scheduled_at, created_at, updated_at
       FROM api_calls
       WHERE call_id = ? AND candidate_phone IN (${ph})
       LIMIT 1`,
      [jobId, ...variants]
    );
    if (rows.length) return rows[0];
  }
  if (email) {
    const [rows] = await db.query(
      `SELECT call_id, status, twilio_call_sid, candidate_name, candidate_email, candidate_phone, scheduled_at, created_at, updated_at
       FROM api_calls
       WHERE call_id = ? AND LOWER(TRIM(candidate_email)) = LOWER(TRIM(?))
       LIMIT 1`,
      [jobId, email]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

async function fetchJobRowForContact(jobId, contactVariants, email) {
  const [rows] = await db.query(
    `SELECT job_id, title, names, emails, numbers, created_at, scheduled_datetime, scheduled_datetime_utc,
            timezone_abbreviation, call_schedule, scheduled_call_status
     FROM jobs
     WHERE job_id = ?
     ORDER BY id DESC
     LIMIT 50`,
    [jobId]
  );
  return rows.find((j) => jobRowMatchesContact(j, contactVariants, email)) || null;
}

const fetchUnifiedUserCallSummary = async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!isValidApiBearerToken(token)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or missing API key.'
      });
    }

    const sid = String(req.query.sid || '').trim();
    const jobId = String(req.query.job_id || '').trim();
    const contact = String(req.query.contact || '').trim();
    const contactVariants = buildContactVariants(contact);
    const email = String(req.query.email || '').trim();

    if (!sid && !(jobId && (contact || email))) {
      return res.status(400).json({
        success: false,
        message: "Provide either 'sid' OR 'job_id' + ('contact' or 'email')."
      });
    }

    // 1) Try interview-call summary first
    let whereSql = '';
    const whereParams = [];
    if (sid) {
      whereSql = 'os.sid = ?';
      whereParams.push(sid);
    } else {
      whereSql = 'os.job_id = ?';
      whereParams.push(jobId);
      if (contact) {
        whereSql += ` AND os.contact IN (${contactVariants.map(() => '?').join(', ')})`;
        whereParams.push(...contactVariants);
      } else {
        whereSql += ' AND (fb.user_email = ? OR os.contact IN (SELECT numbers FROM jobs WHERE job_id = ? LIMIT 1))';
        whereParams.push(email, jobId);
      }
    }

    const [overallRows] = await db.query(
      `SELECT
         os.id AS overall_id,
         os.job_id,
         os.contact,
         os.sid,
         os.result_status,
         os.feedback_status,
         os.call_status,
         os.total_questions,
         os.answered_questions,
         os.total_score,
         os.created_at,
         j.title AS job_title,
         fb.user_email
       FROM overall_status os
       LEFT JOIN jobs j ON j.job_id = os.job_id
       LEFT JOIN feedback fb ON fb.sid = os.sid
       WHERE ${whereSql}
       ORDER BY os.id DESC
       LIMIT 1`,
      whereParams
    );

    if (overallRows.length > 0) {
      const overall = overallRows[0];
      const interviewAudioUrl = overall.overall_id
        ? toAbsoluteUrl(req, `/admin/full-audio/${overall.overall_id}/play?download=1`)
        : null;
      const [feedbackRows] = await db.query(
        `SELECT id, question, user_answer, feedback, score, created_at
         FROM feedback
         WHERE sid = ?
         ORDER BY id ASC`,
        [overall.sid]
      );

      const qa = feedbackRows.map((row) => {
        const qObj = safeJsonParse(row.question);
        const aObj = safeJsonParse(row.user_answer);
        return {
          id: row.id,
          question: qObj && typeof qObj === 'object' ? qObj : row.question,
          answer: aObj && typeof aObj === 'object' ? aObj : row.user_answer,
          ai_feedback: row.feedback,
          ai_score: Number(row.score || 0),
          created_at: row.created_at,
          audio_url: row.id ? toAbsoluteUrl(req, `/admin/audio/${row.id}/play?download=1`) : null
        };
      });

      const jobCtx = await fetchJobContextForVerdict(overall.job_id);
      const missionSummary = await generateMissionVerdictAndRecommendationsInterview(overall, feedbackRows, jobCtx);

      return res.status(200).json({
        success: true,
        source: 'interview',
        mission_verdict: missionSummary.mission_verdict,
        mission_recommendations: missionSummary.mission_recommendations,
        user: {
          contact: overall.contact,
          email: overall.user_email || null
        },
        call: {
          sid: overall.sid,
          job_id: overall.job_id,
          job_title: overall.job_title,
          call_status: overall.call_status,
          result_status: overall.result_status,
          feedback_status: overall.feedback_status,
          total_questions: overall.total_questions,
          answered_questions: overall.answered_questions,
          total_score: overall.total_score,
          created_at: overall.created_at,
          audio_url: interviewAudioUrl
        },
        qa
      });
    }

    // 2) Scheduled / pending interview (e.g. portal mock `call_mock_*`) — no overall_status row yet
    if (!sid && jobId && (contact || email)) {
      const apiRowPending = await fetchApiCallRowForJobContact(jobId, contactVariants, email);
      if (apiRowPending) {
        return res.status(200).json({
          success: true,
          source: 'interview',
          mission_verdict: null,
          mission_recommendations: [],
          user: {
            contact: apiRowPending.candidate_phone,
            email: apiRowPending.candidate_email || null,
            name: apiRowPending.candidate_name || null
          },
          call: {
            sid: apiRowPending.twilio_call_sid || null,
            job_id: apiRowPending.call_id,
            job_title: null,
            call_status: apiRowPending.status,
            scheduled_at: apiRowPending.scheduled_at,
            created_at: apiRowPending.created_at,
            audio_url: null
          },
          qa: []
        });
      }

      const jobPending = await fetchJobRowForContact(jobId, contactVariants, email);
      if (jobPending) {
        const preOverallJob = await fetchLatestOverallSnapshot(jobId);
        const statusPending = deriveMissionStatusFromJob(jobPending, preOverallJob);
        const phonesPending = collectPhoneVariantsFromJobNumbers(jobPending.numbers);
        let emailFromJob = null;
        if (typeof jobPending.emails === 'string') {
          emailFromJob = jobPending.emails.split(/[;,]/).map((x) => x.trim()).find(Boolean) || null;
        }
        return res.status(200).json({
          success: true,
          source: 'interview',
          mission_verdict: null,
          mission_recommendations: [],
          user: {
            contact: contact || phonesPending[0] || null,
            email: email || emailFromJob,
            name: firstNameFromJobNames(jobPending.names)
          },
          call: {
            sid: null,
            job_id: jobPending.job_id,
            job_title: jobPending.title,
            call_status: statusPending,
            scheduled_at: jobPending.scheduled_datetime_utc || jobPending.scheduled_datetime,
            created_at: jobPending.created_at,
            audio_url: null
          },
          qa: []
        });
      }
    }

    return res.status(404).json({ success: false, message: 'No matching interview found.' });
  } catch (err) {
    console.error('Error fetching unified user call summary:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

// ✅ Export as a single default object
export default {
    checkEmail,
    saveOtp,
    verifyOtp,
    fetchAuthrizationKey,
    getDashboard,
    fetchUsers,
    fetchJobs,
    fetchCandidates,
    fetchUserFeedback,
    fetchUserFeedbackById,
    initiateCallDisabled,
    fetchUnifiedUserCallSummary

};