import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { interviewConfig } from '../config.js';
import { getSessionUploadDir } from '../services/storage.service.js';

function extname(name) {
  return path.extname(name || '').toLowerCase();
}

function isAllowedImage(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const ext = extname(file.originalname);
  if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/pjpeg'].includes(mime)) return true;
  if (mime.startsWith('image/')) return true;
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return true;
  if (!mime || mime === 'application/octet-stream') {
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  }
  return false;
}

function isAllowedRecording(file) {
  const mime = (file.mimetype || '').toLowerCase();
  const ext = extname(file.originalname);
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  if (['.webm', '.mp4', '.m4a', '.wav', '.ogg', '.mkv'].includes(ext)) return true;
  if (!mime || mime === 'application/octet-stream') {
    return ['.webm', '.mp4', '.m4a', '.wav', '.ogg'].includes(ext);
  }
  return false;
}

function recordingDir(token) {
  const dir = path.join(interviewConfig.recordingsRoot, token);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createSnapshotUpload(token) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, getSessionUploadDir(token));
      } catch (e) {
        cb(e);
      }
    },
    filename: (_req, _file, cb) => {
      cb(null, `snap_${Date.now()}${extname(_file.originalname) || '.jpg'}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: interviewConfig.maxUploadBytes },
    fileFilter: (_req, file, cb) => {
      if (isAllowedImage(file)) cb(null, true);
      else cb(new Error(`Invalid image type: ${file.mimetype || 'unknown'}`), false);
    },
  });
}

/** Video chunks — keep multer name; server renames to chunk_NNN */
export function createRecordingUpload(token) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, recordingDir(token)),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || '.webm';
      cb(null, `upload_${Date.now()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: interviewConfig.maxUploadBytes * 25 },
    fileFilter: (_req, file, cb) => {
      if (isAllowedRecording(file)) cb(null, true);
      else cb(new Error(`Invalid recording type: ${file.mimetype || 'unknown'}`), false);
    },
  });
}

/** Answer audio — final filename includes question id */
export function createAnswerUpload(token) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, recordingDir(token)),
    filename: (req, file, cb) => {
      const qid = req.body?.question_id || req.body?.questionId || '0';
      const ext = extname(file.originalname) || '.webm';
      cb(null, `answer_q${qid}_${Date.now()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: interviewConfig.maxUploadBytes * 10 },
    fileFilter: (_req, file, cb) => {
      if (isAllowedRecording(file)) cb(null, true);
      else cb(new Error(`Invalid answer audio type: ${file.mimetype || 'unknown'}`), false);
    },
  });
}

export function handleMulterUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();
      return res.status(400).json({ error: err.message || 'Upload failed' });
    });
  };
}
