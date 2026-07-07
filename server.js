require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const twilio = require("twilio");
const cropData = require("./data/crop-data.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks send form-encoded data

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Multer: keep uploaded images in memory (no disk writes needed for demo)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB max
});

const CASES_FILE = path.join(__dirname, "data", "cases.json");

function readCases() {
  try {
    return JSON.parse(fs.readFileSync(CASES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeCases(cases) {
  fs.writeFileSync(CASES_FILE, JSON.stringify(cases, null, 2));
}

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ---------- Helper: call Gemini API ----------
async function callGemini(prompt) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text returned from Gemini");
  return text.trim();
}

// ---------- Helper: call Gemini multimodal (image + text) ----------
async function callGeminiVision(base64Image, mimeType, prompt) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Image } },
            { text: prompt },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Vision API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text returned from Gemini Vision");
  return text.trim();
}

// ---------- Helper: parse strict-JSON-ish Gemini output ----------
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------- Helper: fuzzy-match a district name/keyword from free text ----------
function matchDistrict(freeText) {
  const text = (freeText || "").toLowerCase().trim();
  // exact key match first (e.g. "nashik")
  if (cropData[text]) return text;
  // otherwise search district display names (e.g. "Nashik")
  for (const key of Object.keys(cropData)) {
    if (
      text.includes(key) ||
      text.includes(cropData[key].district.toLowerCase())
    ) {
      return key;
    }
  }
  return null;
}

// ---------- Reusable: generate a crop advisory for a district ----------
async function generateCropAdvisory(districtKey, lang) {
  const record = cropData[districtKey];
  if (!record) throw new Error(`No data for district "${districtKey}"`);

  const languageNameMap = {
    hi: "Hindi",
    te: "Telugu",
    mr: "Marathi",
    en: "English",
  };
  const languageName = languageNameMap[lang] || "Hindi";

  const prompt = `You are "Kisan Alert", a friendly agricultural advisor for small and marginal Indian farmers.

Farm data for ${record.district} district:
- Soil type: ${record.soil_type}, pH: ${record.ph}
- Nutrient levels: Nitrogen=${record.n_level}, Phosphorus=${record.p_level}, Potassium=${record.k_level}
- Average rainfall: ${record.avg_rainfall_mm} mm/year
- Groundwater depth: ${record.groundwater_depth_m} meters
- Vegetation health index (NDVI): ${record.ndvi_mock} (0-1 scale, higher is healthier)
- Season: ${record.season}
- Rule-based suggested crops: ${record.recommended_crops.join(", ")}

Task: Write a short, practical crop recommendation for this farmer.
- Respond ONLY in ${languageName} language, using simple everyday words a farmer would understand (avoid technical jargon).
- Mention which crop(s) to prefer and briefly why (soil/water/rainfall reason).
- Include one practical irrigation or fertilizer tip.
- Do not use markdown formatting, just plain conversational text as if speaking to the farmer.
- IMPORTANT: Keep it under 300 characters total so it fits in a single SMS message.`;

  const advisory = await callGemini(prompt);
  return { record, languageName, advisory };
}

// ---------- Health check ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "kisan-alert-backend" });
});

// ---------- List available demo districts (for frontend dropdown) ----------
app.get("/api/districts", (req, res) => {
  const list = Object.keys(cropData).map((key) => ({
    id: key,
    name: cropData[key].district,
  }));
  res.json(list);
});

// ---------- Component 1: Crop Recommendation Engine ----------
// POST /api/crop-advisory  { districtId: "nashik", language: "hi" }
app.post("/api/crop-advisory", async (req, res) => {
  try {
    const { districtId, language } = req.body;
    const lang = language || "hi"; // default Hindi
    const key = (districtId || "").toLowerCase().trim();

    if (!cropData[key]) {
      return res.status(404).json({
        error: `No data found for district "${districtId}". Available: ${Object.keys(
          cropData,
        ).join(", ")}`,
      });
    }

    const { record, languageName, advisory } = await generateCropAdvisory(
      key,
      lang,
    );

    res.json({
      district: record.district,
      language: languageName,
      inputData: record,
      advisory,
    });
  } catch (err) {
    console.error("crop-advisory error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Component 2: Crop Health Photo Diagnosis ----------
// POST /api/photo-diagnosis  (multipart/form-data, field name: "image")
// Optional text fields: farmerId, farmerName, district, language
app.post("/api/photo-diagnosis", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No image file uploaded. Use field name 'image'." });
    }

    const { farmerId, farmerName, district, language } = req.body;
    const lang = language || "hi";
    const languageNameMap = {
      hi: "Hindi",
      te: "Telugu",
      mr: "Marathi",
      en: "English",
    };
    const languageName = languageNameMap[lang] || "Hindi";

    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;

    const prompt = `You are an expert plant pathologist helping small Indian farmers.
Look at this crop/leaf photo and diagnose any visible disease, pest damage, or nutrient deficiency.

Respond ONLY with valid JSON (no markdown, no extra text) in exactly this shape:
{
  "disease_name": "string, or 'No visible issue' if healthy",
  "confidence": number between 0 and 100,
  "severity": "low" | "medium" | "high",
  "recommendation_${lang}": "1-2 sentence practical recommendation written in ${languageName}, simple farmer-friendly language",
  "recommendation_en": "same recommendation in English, for internal records"
}`;

    const rawText = await callGeminiVision(base64Image, mimeType, prompt);
    let diagnosis;
    try {
      diagnosis = extractJson(rawText);
    } catch {
      // fallback if Gemini didn't return clean JSON
      diagnosis = {
        disease_name: "Could not parse diagnosis",
        confidence: 0,
        severity: "medium",
        [`recommendation_${lang}`]: rawText,
        recommendation_en: rawText,
      };
    }

    const shouldEscalate =
      diagnosis.confidence < 70 || diagnosis.severity === "high";

    const caseRecord = {
      id: uuidv4(),
      farmerId: farmerId || "unknown",
      farmerName: farmerName || "Unknown Farmer",
      district: district || "unknown",
      timestamp: new Date().toISOString(),
      diagnosis,
      status: shouldEscalate ? "escalated" : "auto_resolved",
    };

    const cases = readCases();
    cases.unshift(caseRecord); // newest first
    writeCases(cases);

    res.json(caseRecord);
  } catch (err) {
    console.error("photo-diagnosis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Rythu Seva Kendra Dashboard support routes ----------
// GET /api/cases?status=escalated  -> list cases (optionally filtered)
app.get("/api/cases", (req, res) => {
  const { status } = req.query;
  const cases = readCases();
  const filtered = status ? cases.filter((c) => c.status === status) : cases;
  res.json(filtered);
});

// POST /api/cases/:id/resolve  -> Kendra staff marks a case resolved
app.post("/api/cases/:id/resolve", (req, res) => {
  const { id } = req.params;
  const cases = readCases();
  const idx = cases.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Case not found" });

  cases[idx].status = "resolved";
  cases[idx].resolvedAt = new Date().toISOString();
  writeCases(cases);
  res.json(cases[idx]);
});

// ---------- Component: Real SMS via Twilio ----------

// POST /api/send-sms  { phoneNumber: "+9198xxxxxxx", districtId: "nashik", language: "hi" }
// Outbound: triggers an SMS advisory to a real phone (used from your dashboard/demo button)
app.post("/api/send-sms", async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({
        error:
          "Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env",
      });
    }
    const { phoneNumber, districtId, language } = req.body;
    if (!phoneNumber || !districtId) {
      return res
        .status(400)
        .json({ error: "phoneNumber and districtId are required" });
    }
    const key = districtId.toLowerCase().trim();
    if (!cropData[key]) {
      return res
        .status(404)
        .json({ error: `Unknown district "${districtId}"` });
    }

    const { advisory } = await generateCropAdvisory(key, language || "hi");

    const message = await twilioClient.messages.create({
      body: `Kisan Alert:\n${advisory}`,
      from: TWILIO_PHONE_NUMBER,
      to: phoneNumber,
    });

    res.json({ sent: true, sid: message.sid, advisory });
  } catch (err) {
    console.error("send-sms error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /sms/inbound  <- Twilio webhook (configure this URL in Twilio console
// under your phone number's "A MESSAGE COMES IN" setting)
// Farmer texts a district name (e.g. "Nashik") to your Twilio number,
// this replies automatically with a crop advisory via SMS.
app.post("/sms/inbound", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const incomingText = req.body.Body || "";
    const districtKey = matchDistrict(incomingText);

    if (!districtKey) {
      twiml.message(
        `Kisan Alert: District not recognized. Please reply with a district name, e.g. Nashik, Nagpur, Jodhpur, Meerut, or Guntur.`,
      );
    } else {
      const { advisory } = await generateCropAdvisory(districtKey, "hi");
      twiml.message(`Kisan Alert:\n${advisory}`);
    }
  } catch (err) {
    console.error("sms/inbound error:", err);
    twiml.message(
      "Kisan Alert: Sorry, something went wrong. Please try again later.",
    );
  }

  res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Kisan Alert backend running on port ${PORT}`);
  console.log(`Try: POST http://localhost:${PORT}/api/crop-advisory`);
});
