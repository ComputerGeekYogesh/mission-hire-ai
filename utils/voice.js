// utils/voice.js

// export const wrapWithVoiceTags = (text, rate = '100%') => {
//   return `
//     <speak>
//       <prosody rate="${rate}">
//         ${text}
//       </prosody>
//     </speak>
//   `;
// };

export const wrapWithVoiceTags = (text, rate = '102%', pitch = '+4%') => {
  return `
    <speak>
      <prosody rate="${rate}" pitch="${pitch}">
        ${text}
      </prosody>
      <break time="400ms"/>
    </speak>
  `;
};
