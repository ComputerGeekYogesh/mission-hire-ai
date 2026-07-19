export function validateTelemetryPayload(body) {
  const yaw = body.yaw != null ? Number(body.yaw) : null;
  const pitch = body.pitch != null ? Number(body.pitch) : null;

  if (yaw != null && Number.isNaN(yaw)) {
    const err = new Error('Invalid yaw value');
    err.status = 400;
    throw err;
  }
  if (pitch != null && Number.isNaN(pitch)) {
    const err = new Error('Invalid pitch value');
    err.status = 400;
    throw err;
  }

  return {
    yaw,
    pitch,
    roll: body.roll != null ? Number(body.roll) : null,
    blink: body.blink != null ? Number(body.blink) : body.blink_count != null ? Number(body.blink_count) : 0,
    faceDetected: Boolean(body.faceDetected ?? body.face_detected),
    face_count: body.face_count != null ? Number(body.face_count) : undefined,
    movement_score: body.movement_score != null ? Number(body.movement_score) : undefined,
    mic_active: body.mic_active !== false,
    camera_active: body.camera_active !== false,
    tab_visible: body.tab_visible !== false,
    window_blur: Boolean(body.window_blur),
    face_absent_seconds: body.face_absent_seconds != null ? Number(body.face_absent_seconds) : undefined,
    timestamp: body.timestamp || new Date().toISOString(),
    headphone_status: body.headphone_status || 'unknown',
    headphones_detected:
      body.headphones_detected !== false &&
      body.headphone_status !== 'not_detected' &&
      body.headphones_detected !== 'false',
    face_signature: typeof body.face_signature === 'string' ? body.face_signature : undefined,
    speech_transcript:
      typeof body.speech_transcript === 'string' ? body.speech_transcript.slice(0, 4000) : undefined,
    current_question_text:
      typeof body.current_question_text === 'string' ? body.current_question_text.slice(0, 2000) : undefined,
    current_question_id:
      body.current_question_id != null ? Number(body.current_question_id) : undefined,
    // Attention / gaze monitoring (client-derived from iris + head pose)
    gaze_yaw: body.gaze_yaw != null ? Number(body.gaze_yaw) : undefined,
    gaze_pitch: body.gaze_pitch != null ? Number(body.gaze_pitch) : undefined,
    gaze_valid: body.gaze_valid === true,
    attention_direction: typeof body.attention_direction === 'string' ? body.attention_direction : undefined,
    looking_down: body.looking_down === true,
    looking_side: body.looking_side === true,
    on_screen: body.on_screen !== false,
    downward_gaze_seconds:
      body.downward_gaze_seconds != null ? Number(body.downward_gaze_seconds) : undefined,
    off_screen_gaze_seconds:
      body.off_screen_gaze_seconds != null ? Number(body.off_screen_gaze_seconds) : undefined,
    off_screen_direction:
      typeof body.off_screen_direction === 'string' ? body.off_screen_direction : undefined,
    side_glance_count: body.side_glance_count != null ? Number(body.side_glance_count) : undefined,
    gaze_shift_count: body.gaze_shift_count != null ? Number(body.gaze_shift_count) : undefined,
    screen_attention_pct:
      body.screen_attention_pct != null ? Number(body.screen_attention_pct) : undefined,
    reading_pattern_score:
      body.reading_pattern_score != null ? Number(body.reading_pattern_score) : undefined,
    pre_answer_glance_down: body.pre_answer_glance_down === true,
    tilted_down_while_speaking_sec:
      body.tilted_down_while_speaking_sec != null
        ? Number(body.tilted_down_while_speaking_sec)
        : undefined,
    attention_window_sec:
      body.attention_window_sec != null ? Number(body.attention_window_sec) : undefined,
    attention_sample_count:
      body.attention_sample_count != null ? Number(body.attention_sample_count) : undefined,
    gaze_off_screen_seconds:
      body.gaze_off_screen_seconds != null ? Number(body.gaze_off_screen_seconds) : undefined,
    gaze_down_seconds: body.gaze_down_seconds != null ? Number(body.gaze_down_seconds) : undefined,
    gaze_fixed_off_seconds:
      body.gaze_fixed_off_seconds != null ? Number(body.gaze_fixed_off_seconds) : undefined,
    gaze_fixed_zone: typeof body.gaze_fixed_zone === 'string' ? body.gaze_fixed_zone : undefined,
    head_off_screen_seconds:
      body.head_off_screen_seconds != null ? Number(body.head_off_screen_seconds) : undefined,
    head_down_seconds: body.head_down_seconds != null ? Number(body.head_down_seconds) : undefined,
    combined_down_seconds:
      body.combined_down_seconds != null ? Number(body.combined_down_seconds) : undefined,
    gaze_moves_10s: body.gaze_moves_10s != null ? Number(body.gaze_moves_10s) : undefined,
    head_turns_10s: body.head_turns_10s != null ? Number(body.head_turns_10s) : undefined,
    gaze_off_screen_pct_10s:
      body.gaze_off_screen_pct_10s != null ? Number(body.gaze_off_screen_pct_10s) : undefined,
    head_off_screen_pct_10s:
      body.head_off_screen_pct_10s != null ? Number(body.head_off_screen_pct_10s) : undefined,
    gaze_scanning_10s: body.gaze_scanning_10s === true,
    head_scanning_10s: body.head_scanning_10s === true,
    answer_phase_active: body.answer_phase_active === true,
    answer_gaze_off_pct:
      body.answer_gaze_off_pct != null ? Number(body.answer_gaze_off_pct) : undefined,
    answer_head_off_pct:
      body.answer_head_off_pct != null ? Number(body.answer_head_off_pct) : undefined,
    pre_speech_glance_count:
      body.pre_speech_glance_count != null ? Number(body.pre_speech_glance_count) : undefined,
    gaze_zone: typeof body.gaze_zone === 'string' ? body.gaze_zone : undefined,
    head_zone: typeof body.head_zone === 'string' ? body.head_zone : undefined,
  };
}
