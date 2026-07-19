export default function protectRoute(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization header missing or malformed' });
  }

  // Extract the token part after 'Bearer '
  const encodedApiKey = authHeader.split(' ')[1];

  // Decode the Base64 encoded API key
  const decodedApiKey = Buffer.from(encodedApiKey, 'base64').toString('utf8');

  const actualApiKey = process.env.API_KEY; // e.g., 'supersecret123'

  if (decodedApiKey !== actualApiKey) {
    return res.status(403).json({ message: 'Invalid API key' });
  }

  next();
}