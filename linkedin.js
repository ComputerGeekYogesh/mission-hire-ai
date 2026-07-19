// routes/linkedinJobPost.js
import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Use environment variables for security
const ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const OWNER_URN = process.env.LINKEDIN_OWNER_URN;
console.log("hello world");
router.get('/test', (req, res) => {
    res.status(200).json({ message: 'LinkedIn job post route is working!' });
});
router.post('/post-job', async (req, res) => {
  const {
    entityUrl = 'https://www.example.com/content.html',
    imageUrl = 'https://www.example.com/image.jpg',
    title = 'Test Share with Content',
    subject = 'Test Share Subject',
    text = 'Test Share!'
  } = req.body;

  const payload = {
    owner: OWNER_URN,
    subject: subject,
    text: {
      text: text
    },
    content: {
      contentEntities: [
        {
          entityLocation: entityUrl,
          thumbnails: [
            {
              resolvedUrl: imageUrl
            }
          ]
        }
      ],
      title: title
    },
    distribution: {
      linkedInDistributionTarget: {}
    }
  };

  try {
    const response = await axios.post(
      'https://api.linkedin.com/v2/shares',
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    res.status(200).json({
      message: 'Job content posted successfully!',
      shareResponse: response.data
    });
  } catch (error) {
    console.error('❌ LinkedIn API Error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to post job content to LinkedIn',
      details: error.response?.data || error.message
    });
  }
});

export default router;