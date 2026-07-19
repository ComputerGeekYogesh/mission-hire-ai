import express from 'express';
import authController from '../controllers/authController.js';
import apiController from '../controllers/apiController.js';
import redirectIfAuthenticated from '../middlewares/redirectIfAuthenticated.js';

const router = express.Router();

router.get('/', redirectIfAuthenticated, authController.getLanding);
router.get('/login', redirectIfAuthenticated, authController.getLogin);
router.post('/send-otp', redirectIfAuthenticated, authController.sendOTP);
router.post('/verify-otp', redirectIfAuthenticated, authController.verifyOTP);
router.get('/verify-email', authController.verifyLink);
router.post('/verify-code', authController.submitVerificationCode);
router.get('/logout', authController.logout);
router.get('/fetch-authrization-key', apiController.fetchAuthrizationKey);





export default router;
