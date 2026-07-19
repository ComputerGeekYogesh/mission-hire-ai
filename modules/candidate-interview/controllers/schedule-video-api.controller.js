import { validateScheduleVideoInterviewPayload } from '../validators/schedule-video-api.validator.js';
import { scheduleVideoApiService } from '../services/schedule-video-api.service.js';

function apiError(res, status, message, errors = []) {
  return res.status(status).json({
    success: false,
    message,
    errors: errors.length ? errors : [message],
  });
}

export async function scheduleVideoInterview(req, res) {
  try {
    const validation = validateScheduleVideoInterviewPayload(req.body);
    if (!validation.ok) {
      return apiError(res, 400, 'Validation failed', validation.errors);
    }

    const result = await scheduleVideoApiService.scheduleVideoInterview(validation.data);

    return res.status(201).json({
      success: true,
      message: 'Video interview scheduled successfully',
      data: {
        interview_id: String(result.session.id),
        candidate_name: result.session.candidate_name,
        email: result.session.candidate_email,
        scheduled_at: validation.data.scheduled_at_iso,
        timezone: validation.data.timezone,
        interview_link: result.interviewLink,
        status: 'scheduled',
        email_sent: result.emailSent,
      },
    });
  } catch (err) {
    if (err.status === 409) {
      return apiError(res, 409, 'Conflict', err.errors || [err.message]);
    }
    console.error('[scheduleVideoInterview]', err.message, err.stack);
    return apiError(res, 500, 'Internal server error');
  }
}
