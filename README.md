# Kisan Alert — Backend (Component 1: Crop Recommendation Engine)

## What this is

An Express.js API with one core endpoint: given a district, it returns an
AI-generated crop recommendation in Hindi, based on static soil/rainfall/NDVI
data (standing in for BigQuery + Earth Engine for the hackathon demo).

## 1. Run it locally (5 minutes)

```bash
cd kisan-alert-backend
npm install
cp .env.example .env
```

Edit `.env` and paste your Gemini API key (get one free at
https://aistudio.google.com/apikey — takes 30 seconds, no GCP setup needed).

```bash
npm start
```

You should see:

```
Kisan Alert backend running on port 8080
```

## 2. Test it

```bash
curl http://localhost:8080/health

curl http://localhost:8080/api/districts

curl -X POST http://localhost:8080/api/crop-advisory \
  -H "Content-Type: application/json" \
  -d '{"districtId": "nashik", "language": "hi"}'
```

Expected response shape:

```json
{
  "district": "Nashik",
  "language": "Hindi",
  "inputData": { ... },
  "advisory": "नासिक जिले की काली मिट्टी और अच्छी बारिश को देखते हुए..."
}
```

Available demo district IDs: `nashik`, `nagpur`, `jodhpur`, `meerut`, `guntur`
(see `data/crop-data.json` — add more districts here anytime, no code changes needed).

## 3. Deploy to Cloud Run

```bash
# from inside kisan-alert-backend/
gcloud run deploy kisan-alert-backend \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=<your_key_here>
```

This builds the Dockerfile and deploys automatically. gcloud will print a
service URL like:

```
https://kisan-alert-backend-xxxxx-el.a.run.app
```

Save that URL — the frontend (Component 3) will call it directly.

## 4. Component 2 — Photo Diagnosis (new)

Restart the server after pulling this update:

```bash
npm install    # picks up multer + uuid
npm start
```

### Test with a real leaf/crop photo

Find any crop/plant photo on your laptop (or download one), then:

```bash
curl -X POST http://localhost:8080/api/photo-diagnosis \
  -F "image=@/path/to/leaf-photo.jpg" \
  -F "farmerId=F1023" \
  -F "farmerName=Ramesh Patil" \
  -F "district=nashik" \
  -F "language=hi"
```

Expected response:

```json
{
  "id": "a1b2c3...",
  "farmerId": "F1023",
  "farmerName": "Ramesh Patil",
  "district": "nashik",
  "timestamp": "2026-07-05T...",
  "diagnosis": {
    "disease_name": "Leaf blight",
    "confidence": 62,
    "severity": "high",
    "recommendation_hi": "...",
    "recommendation_en": "..."
  },
  "status": "escalated"
}
```

Cases with `confidence < 70` OR `severity == "high"` are auto-marked
`"escalated"` — these are what the Kendra dashboard (Component 4) will show.

### View / manage cases (used by the dashboard later)

```bash
# list all escalated cases
curl http://localhost:8080/api/cases?status=escalated

# mark a case resolved (replace <id> with a real case id from above)
curl -X POST http://localhost:8080/api/cases/<id>/resolve
```

Cases persist to `data/cases.json` on disk — good enough for a hackathon demo.
Swap this for Firestore later if you have spare hours (same route logic, just
replace `readCases()`/`writeCases()` with Firestore calls).

## 6. Component: Real SMS via Twilio (feature-phone channel)

This is what makes the platform actually reachable from a basic phone with
no internet — real SMS, no app required.

### Step 1 — Create a free Twilio account (~5 min)

1. Go to https://www.twilio.com/try-twilio and sign up (free trial, no card
   needed to start, gives you trial credit).
2. From the Twilio Console dashboard, copy your **Account SID** and
   **Auth Token**.
3. Get a free trial phone number: Console → Phone Numbers → Buy a number →
   pick any number with SMS capability (trial numbers are free).
4. **Important trial limitation:** Twilio trial accounts can only send SMS
   to phone numbers you've verified. Go to Console → Phone Numbers →
   Verified Caller IDs → add your own personal phone number (you'll get a
   verification code by SMS/call). Use this verified number as the
   "farmer's phone" in your demo.

### Step 2 — Add credentials to `.env`

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx    # the Twilio number you bought
```

Restart the server: `npm install && npm start` (picks up the `twilio` package).

### Step 3 — Test outbound SMS (server → farmer's phone)

```bash
curl -X POST http://localhost:8080/api/send-sms \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+91YOUR_VERIFIED_NUMBER", "districtId": "nashik", "language": "hi"}'
```

You should receive a real SMS on your phone within seconds with the crop
advisory. This alone is a strong demo moment.

### Step 4 — Test inbound SMS (farmer texts in → auto-reply)

This needs your backend to be reachable from the internet so Twilio can call
it. Two ways to do this:

**Option A — quick tunnel for local testing (fastest, use during dev):**

```bash
npm install -g ngrok
ngrok http 8080
```

This prints a public URL like `https://abcd1234.ngrok-free.app`. In the
Twilio Console → Phone Numbers → your number → "Messaging" section, set
**"A message comes in"** webhook to:

```
https://abcd1234.ngrok-free.app/sms/inbound
```

Save. Now text your Twilio number from your (verified) phone with just a
district name, e.g. "Nashik" — you should get an automatic SMS reply with
the advisory within a few seconds.

**Option B — deploy to Cloud Run first (more stable, use for demo day):**
Once deployed (see Cloud Run section above), set the webhook to:

```
https://<your-cloud-run-url>/sms/inbound
```

This is more reliable than ngrok for the actual judging round since ngrok
free tunnels can time out or change URLs.

### What to say in your pitch

"A farmer with a basic ₹500 phone and no internet can text a district name
to this number and get a crop advisory in Hindi within seconds — no app,
no data plan required. The same backend also powers voice calls via Twilio
Voice/Dialogflow telephony in production; we're demoing the SMS path live
today since it's the most reliable to show over conference wifi."

## 7. Next steps

- This same server will grow to include `/api/photo-diagnosis` (Component 2).
- Keep `data/crop-data.json` as your safety net: if Earth Engine/BigQuery
  aren't wired up in time, this static file IS your data layer for the demo
  and nobody will know the difference.
- To add a new demo village fast: copy a block in `crop-data.json`, change
  the district name and values — takes 30 seconds.
