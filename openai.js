import axios from 'axios';
export const transcribeAudioChunk = async (buffer) => {
  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', buffer, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'audio/wav' }
  });
  return res.data.text;
};

export const chatWithGpt = async (inputText, systemPrompt = "default") => {
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: inputText }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });

  return res.data.choices[0].message.content;
};
