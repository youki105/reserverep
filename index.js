require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_ANON_KEY exists?", !!process.env.SUPABASE_ANON_KEY);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// In-memory sessions (OK for MVP; later we’ll move this to DB/Redis)
const sessions = {};

function calculateNights(checkin, checkout) {
  const start = new Date(checkin);
  const end = new Date(checkout);
  const diffTime = end - start;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// ---------------- ROOT ----------------
app.get("/", (req, res) => {
  res.send("ReserveRep AI is running.");
});

// ---------------- ADMIN AUTH ----------------
function adminAuth(req, res, next) {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send("Unauthorized");
  }
  next();
}

// ---------------- ADMIN: VIEW BOOKINGS ----------------
// Optional filter: /admin/reservations?token=XXX&hotel_id=1
app.get("/admin/reservations", adminAuth, async (req, res) => {
  const hotelId = req.query.hotel_id ? Number(req.query.hotel_id) : null;

  let query = supabase
    .from("reservations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (hotelId) query = query.eq("hotel_id", hotelId);

  const { data, error } = await query;
  if (error) return res.status(500).json(error);

  res.json(data);
});

// ---------------- ADMIN: LIST HOTELS ----------------
// /admin/hotels?token=XXX
app.get("/admin/hotels", adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("hotels")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json(error);
  res.json(data);
});

// ---------------- ADMIN: EXPORT CSV ----------------
// Optional filter: /admin/export?token=XXX&hotel_id=1
app.get("/admin/export", adminAuth, async (req, res) => {
  const hotelId = req.query.hotel_id ? Number(req.query.hotel_id) : null;

  let query = supabase.from("reservations").select("*");
  if (hotelId) query = query.eq("hotel_id", hotelId);

  const { data, error } = await query;
  if (error) return res.status(500).json(error);

  let csv =
    "Reference,HotelId,Phone,Checkin,Checkout,Guests,Nights,Price Per Night,Total,Status,Created At\n";

  data.forEach((r) => {
    csv += `${r.reference_no || ""},${r.hotel_id || ""},${r.phone || ""},${r.checkin || ""},${
      r.checkout || ""
    },${r.guests ?? ""},${r.nights ?? ""},${r.price_per_night ?? ""},${r.total_price ?? ""},${
      r.status || ""
    },${r.created_at || ""}\n`;
  });

  res.header("Content-Type", "text/csv");
  res.attachment("reservations.csv");
  res.send(csv);
});

// ---------------- WHATSAPP WEBHOOK ----------------
app.post("/webhook", async (req, res) => {
  const from = req.body.From; // user number
  const to = req.body.To;     // hotel / Twilio number (key for routing)
  const incomingMsg = (req.body.Body || "").trim();

  console.log("Incoming:", { from, to, incomingMsg });

  // 1) Identify which hotel this message belongs to
  const { data: hotel, error: hotelErr } = await supabase
    .from("hotels")
    .select("id, name, price_per_night, currency, is_active")
    .eq("whatsapp_to", to)
    .maybeSingle();

  if (hotelErr) {
    console.error("Hotel lookup error:", hotelErr);
    return sendTwiml(res, "System error (hotel lookup). Please try again.");
  }

  if (!hotel) {
    return sendTwiml(res, "This hotel number is not configured in ReserveRep yet.");
  }

  if (!hotel.is_active) {
    return sendTwiml(res, `${hotel.name} is currently unavailable. Please try again later.`);
  }

  // 2) Create a session per (hotel + user) so the same user can message multiple hotels
  const sessionKey = `${hotel.id}:${from}`;
  if (!sessions[sessionKey]) {
    sessions[sessionKey] = { step: "start" };
  }

  const session = sessions[sessionKey];
  let reply = "";

  try {
    if (session.step === "start") {
      reply = `Welcome to ${hotel.name} 🏨\nPlease enter your check-in date (YYYY-MM-DD).`;
      session.step = "checkin";
    } else if (session.step === "checkin") {
      session.checkin = incomingMsg;
      reply = "Great 👍 Now enter your check-out date (YYYY-MM-DD).";
      session.step = "checkout";
    } else if (session.step === "checkout") {
      session.checkout = incomingMsg;
      reply = "How many guests will be staying?";
      session.step = "guests";
    } else if (session.step === "guests") {
      const guestsNum = Number(incomingMsg);
      session.guests = Number.isFinite(guestsNum) ? guestsNum : null;

      const nights = calculateNights(session.checkin, session.checkout);
      const pricePerNight = Number(hotel.price_per_night);
      const total = nights * pricePerNight;

      session.nights = nights;
      session.pricePerNight = pricePerNight;
      session.total = total;

      reply = `Perfect 👌

🏨 Deluxe Room — ${hotel.name}
📅 ${session.checkin} → ${session.checkout}
🌙 ${nights} nights
💵 ${hotel.currency}${pricePerNight} per night
💰 Total: ${hotel.currency}${total}

Would you like to confirm this reservation? (Yes/No)`;

      session.step = "confirm";
    } else if (session.step === "confirm") {
      if (incomingMsg.toLowerCase().includes("yes")) {
        const reference = "RR-" + Date.now();

        const { error } = await supabase.from("reservations").insert([
          {
            reference_no: reference,
            hotel_id: hotel.id,
            phone: from,
            hotel: hotel.name, // optional display field
            checkin: session.checkin,
            checkout: session.checkout,
            guests: session.guests,
            nights: session.nights,
            price_per_night: session.pricePerNight,
            total_price: session.total,
            status: "confirmed",
          },
        ]);

        if (error) {
          console.error("Database insert error:", error);
          reply = "There was a system error. Please try again later.";
        } else {
          reply = `🎉 Booking Confirmed!

Hotel: ${hotel.name}
Reference No: ${reference}

Thank you for choosing ReserveRep. Our team will contact you shortly.`;
        }

        delete sessions[sessionKey];
      } else {
        reply = "No problem 😊 Would you like to start a new booking?";
        sessions[sessionKey] = { step: "start" };
      }
    } else {
      reply = "How can I assist you today?";
      sessions[sessionKey] = { step: "start" };
    }
  } catch (err) {
    console.error("System error:", err);
    reply = "There was a system error. Please try again later.";
  }

  return sendTwiml(res, reply);
});

// Helper to send Twilio XML
function sendTwiml(res, message) {
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${escapeXml(message)}</Message>
    </Response>
  `);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});