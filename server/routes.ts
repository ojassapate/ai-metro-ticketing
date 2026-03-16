import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import { storage } from "./storage";
import { registerSchema, loginSchema, bookTicketSchema, topUpSchema, withdrawSchema, scanTicketSchema, updateProfileSchema, MAX_WALLET_BALANCE } from "@shared/schema";
import QRCode from "qrcode";
import crypto from "crypto";
import memorystore from "memorystore";
import { assistantModel, insightsModel } from "./lib/gemini";

const MemoryStore = memorystore(session);

declare module "express-session" {
  interface SessionData {
    userId: number;
    chatHistory?: { role: string; content: string }[];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Please log in" });
  }
  next();
}

async function requireAdmin(req: Request, res: Response, next: Function) {
  if (!req.session.userId) return res.status(401).json({ message: "Please log in" });
  const user = await storage.getUserById(req.session.userId);
  if (!user || user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}

async function requireScanner(req: Request, res: Response, next: Function) {
  if (!req.session.userId) return res.status(401).json({ message: "Please log in" });
  const user = await storage.getUserById(req.session.userId);
  if (!user || (user.role !== "scanner" && user.role !== "admin")) {
    return res.status(403).json({ message: "Scanner or Admin access required" });
  }
  next();
}

function getDemandLevel(hour: number, crowdLevel: string): string {
  const isPeak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19);
  if (isPeak && crowdLevel === "high") return "high";
  if (isPeak || crowdLevel === "medium") return "medium";
  return "low";
}

function getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getPricingMultiplier(demandLevel: string): number {
  if (demandLevel === "high") return 1.10;
  if (demandLevel === "medium") return 1.05;
  if (demandLevel === "low") return 0.95;
  return 1.00;
}

function getRecommendation(demandLevel: string): string {
  if (demandLevel === "high") {
    return `High demand detected. A 10% surge is applied (capped at ₹110). Consider traveling during off-peak hours for lower fares.`;
  }
  if (demandLevel === "medium") {
    return `Moderate demand. Standard fares with a slight 5% adjustment apply.`;
  }
  return `Low demand - great time to travel! Enjoy a 5% discount on your fare today.`;
}

function calculateBaseFare(distKm: number): number {
  if (distKm <= 2) return 10;
  if (distKm <= 4) return 20;
  if (distKm <= 6) return 30;
  if (distKm <= 8) return 40;
  if (distKm <= 10) return 50;
  if (distKm <= 12) return 60;
  if (distKm <= 15) return 60; // Chart says 10-12=60, 15-20=70. Mapping 12-15 to 60.
  if (distKm <= 20) return 70;
  if (distKm <= 25) return 80;
  return 90;
}

// ── Main Routing ─────────────────────────────────────────────────────────────

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "metro-secret-key-dev",
      resave: false,
      saveUninitialized: false,
      store: new MemoryStore({ checkPeriod: 86400000 }),
      cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
    })
  );

  // ── Gemini-Powered AI Assistant ──
  app.post("/api/assistant", async (req, res) => {
    try {
      const { message, conversationState } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ message: "Message is required" });
      }

      const allStations = await storage.getAllStations();
      const stationContext = allStations.map(s => `${s.name} (${s.line} line, ${s.crowdLevel} crowd)`).join(", ");
      
      const chat = assistantModel.startChat({
        history: (req.session.chatHistory || []).map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      });

      const prompt = `User message: ${message}\nContext: ${stationContext}\n\nRespond as a helpful metro assistant. Be very brief (max 2 sentences). Use only plain text. Do NOT include any JSON.`;
      
      const result = await chat.sendMessage(prompt);
      const replyWithMarker = result.response.text();
      
      // Separate the clean reply from any booking marker
      let reply = replyWithMarker;
      let bookingDraft = null;
      
      const markerMatch = replyWithMarker.match(/\[\[BOOKING_INTENT:\s*({.*?})\s*\]\]/);
      if (markerMatch) {
        try {
          const intentData = JSON.parse(markerMatch[1]);
          reply = replyWithMarker.replace(markerMatch[0], "").trim();
          
          const allStations = await storage.getAllStations();
          const sourceStation = allStations.find(s => 
            s.name.toLowerCase().includes(intentData.source.toLowerCase())
          );
          const destStation = allStations.find(s => 
            s.name.toLowerCase().includes(intentData.dest.toLowerCase())
          );
          
          if (sourceStation && destStation) {
            const distKm = getDistanceKm(Number(sourceStation.lat), Number(sourceStation.lng), Number(destStation.lat), Number(destStation.lng));
            const baseFare = calculateBaseFare(distKm);
            const passengerCount = Math.max(1, Math.min(12, intentData.count || 1));
            const hour = new Date().getHours();
            const demandLevel = getDemandLevel(hour, sourceStation.crowdLevel || "low");
            const dynamicFare = Math.min(110, Math.round(baseFare * getPricingMultiplier(demandLevel)));
            const totalFare = dynamicFare * passengerCount;
            
            bookingDraft = {
              sourceId: sourceStation.id,
              sourceName: sourceStation.name,
              destId: destStation.id,
              destName: destStation.name,
              count: passengerCount,
              totalFare: totalFare
            };
          }
        } catch (e) {
          console.error("Failed to parse booking intent:", e);
        }
      }

      const suggestions = ["Next train timing", "Plan a route", "Book a ticket", "Crowd levels"];
      
      const aiResult = {
        reply: reply,
        suggestions: suggestions,
        action: bookingDraft ? "book_confirm" : "none",
        bookingDraft: bookingDraft,
        nextState: conversationState || {}
      };

      // Add to session history (clean reply)
      const history = req.session.chatHistory || [];
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: reply });
      req.session.chatHistory = history.slice(-10);

      res.json(aiResult);
    } catch (error: any) {
      console.error("Gemini Assistant Error:", error);
      res.status(500).json({ reply: "My AI circuits are currently crossed. Please try again in a moment!" });
    }
  });

  // ── Auth Routes ──
  app.post("/api/auth/register", async (req, res) => {
    try {
      const parsed = registerSchema.parse(req.body);
      const existing = await storage.getUserByEmail(parsed.email);
      if (existing) return res.status(400).json({ message: "An account with this email already exists" });
      
      const hashedPassword = crypto.createHash("sha256").update(parsed.password).digest("hex");
      let role = (parsed.adminSecret === process.env.ADMIN_SECRET && parsed.role) ? parsed.role : "user";

      const user = await storage.createUser({
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        password: hashedPassword,
        role: role,
      });
      await storage.updateWalletBalance(user.id, 500);
      await storage.createWalletTransaction(user.id, 500, "credit", "Welcome bonus!");
      req.session.userId = user.id;
      const updatedUser = await storage.getUserById(user.id);
      res.json({ id: user.id, name: user.name, email: user.email, role: user.role, walletBalance: 500 });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.parse(req.body);
      const user = await storage.getUserByEmail(parsed.email);
      const hashedPassword = crypto.createHash("sha256").update(parsed.password).digest("hex");
      if (!user || user.password !== hashedPassword) return res.status(401).json({ message: "Invalid email or password" });
      
      req.session.userId = user.id;
      res.json({ id: user.id, name: user.name, email: user.email, role: user.role, walletBalance: user.walletBalance });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => res.json({ message: "Logged out" })); });

  app.get("/api/auth/me", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    res.json(user);
  });

  // ── Wallet Routes ──
  app.get("/api/wallet/balance", requireAuth, async (req, res) => {
    const user = await storage.getUserById(req.session.userId!);
    res.json({ balance: user!.walletBalance });
  });

  app.post("/api/wallet/topup", requireAuth, async (req, res) => {
    try {
      const parsed = topUpSchema.parse(req.body);
      const user = await storage.getUserById(req.session.userId!);
      
      if (user!.walletBalance + parsed.amount > MAX_WALLET_BALANCE) {
        return res.status(400).json({ message: `Adding ₹${parsed.amount} would exceed the maximum balance of ₹${MAX_WALLET_BALANCE}` });
      }
      
      const newBalance = user!.walletBalance + parsed.amount;
      await storage.updateWalletBalance(user!.id, newBalance);
      await storage.createWalletTransaction(user!.id, parsed.amount, "credit", `Wallet top-up`);
      res.json({ balance: newBalance });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Top-up failed" });
    }
  });

  app.post("/api/wallet/withdraw", requireAuth, async (req, res) => {
    try {
      const parsed = withdrawSchema.parse(req.body);
      const user = await storage.getUserById(req.session.userId!);
      
      if (user!.walletBalance < parsed.amount) {
        return res.status(400).json({ message: "Insufficient balance for withdrawal" });
      }
      
      const newBalance = user!.walletBalance - parsed.amount;
      await storage.updateWalletBalance(user!.id, newBalance);
      await storage.createWalletTransaction(user!.id, parsed.amount, "debit", `Wallet withdrawal`);
      res.json({ balance: newBalance });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Withdrawal failed" });
    }
  });

  app.get("/api/wallet/transactions", requireAuth, async (req, res) => {
    res.json(await storage.getWalletTransactions(req.session.userId!));
  });

  // ── Ticketing Routes ──
  app.get("/api/stations", async (_req, res) => { res.json(await storage.getAllStations()); });

  app.get("/api/pricing", async (req, res) => {
    try {
      const { sourceId, destId } = req.query;
      if (!sourceId || !destId) return res.status(400).json({ message: "Source and Destination required" });
      
      const source = await storage.getStation(parseInt(sourceId as string));
      const dest = await storage.getStation(parseInt(destId as string));
      if (!source || !dest) return res.status(404).json({ message: "Station not found" });

      const hour = new Date().getHours();
      const distKm = getDistanceKm(Number(source.lat), Number(source.lng), Number(dest.lat), Number(dest.lng));
      const demandLevel = getDemandLevel(hour, dest.crowdLevel);
      const multiplier = getPricingMultiplier(demandLevel);
      const baseFare = calculateBaseFare(distKm);
      const dynamicFare = Math.min(110, Math.round(baseFare * multiplier));

      res.json({
        baseFare,
        dynamicFare,
        multiplier,
        demandLevel,
        recommendation: getRecommendation(demandLevel)
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Pricing calculation failed" });
    }
  });

  // ── Bangalore Locations Database (150+ POIs with categories) ──
  const BANGALORE_LOCATIONS: { name: string; lat: number; lng: number; area: string; category: string }[] = [
    // ── Areas / Neighborhoods ──
    { name: "Koramangala", lat: 12.9352, lng: 77.6245, area: "South East", category: "area" },
    { name: "HSR Layout", lat: 12.9116, lng: 77.6389, area: "South East", category: "area" },
    { name: "Electronic City", lat: 12.8456, lng: 77.6603, area: "South", category: "area" },
    { name: "Whitefield", lat: 12.9698, lng: 77.7500, area: "East", category: "area" },
    { name: "Marathahalli", lat: 12.9591, lng: 77.6974, area: "East", category: "area" },
    { name: "BTM Layout", lat: 12.9166, lng: 77.6101, area: "South", category: "area" },
    { name: "JP Nagar", lat: 12.9063, lng: 77.5857, area: "South", category: "area" },
    { name: "Jayanagar", lat: 12.9250, lng: 77.5838, area: "South", category: "area" },
    { name: "Basavanagudi", lat: 12.9430, lng: 77.5740, area: "South", category: "area" },
    { name: "Malleshwaram", lat: 12.9970, lng: 77.5713, area: "North West", category: "area" },
    { name: "Rajajinagar", lat: 12.9895, lng: 77.5544, area: "North West", category: "area" },
    { name: "Hebbal", lat: 13.0358, lng: 77.5970, area: "North", category: "area" },
    { name: "Yelahanka", lat: 13.1007, lng: 77.5963, area: "North", category: "area" },
    { name: "KR Puram", lat: 13.0047, lng: 77.6860, area: "East", category: "area" },
    { name: "Majestic", lat: 12.9767, lng: 77.5713, area: "Central", category: "area" },
    { name: "MG Road", lat: 12.9756, lng: 77.6065, area: "Central", category: "area" },
    { name: "Brigade Road", lat: 12.9716, lng: 77.6070, area: "Central", category: "area" },
    { name: "Commercial Street", lat: 12.9820, lng: 77.6090, area: "Central", category: "area" },
    { name: "Indiranagar", lat: 12.9784, lng: 77.6408, area: "East", category: "area" },
    { name: "Bannerghatta Road", lat: 12.8872, lng: 77.5969, area: "South", category: "area" },
    { name: "Sarjapur Road", lat: 12.9100, lng: 77.6850, area: "South East", category: "area" },
    { name: "Bellandur", lat: 12.9255, lng: 77.6760, area: "South East", category: "area" },
    { name: "Silk Board", lat: 12.9173, lng: 77.6236, area: "South", category: "area" },
    { name: "Domlur", lat: 12.9610, lng: 77.6387, area: "East", category: "area" },
    { name: "Ulsoor", lat: 12.9812, lng: 77.6199, area: "Central", category: "area" },
    { name: "Shivajinagar", lat: 12.9857, lng: 77.6049, area: "Central", category: "area" },
    { name: "Sadashivanagar", lat: 13.0060, lng: 77.5760, area: "North", category: "area" },
    { name: "Banashankari", lat: 12.9152, lng: 77.5738, area: "South", category: "area" },
    { name: "Vijayanagar", lat: 12.9611, lng: 77.5328, area: "West", category: "area" },
    { name: "Peenya", lat: 13.0215, lng: 77.5185, area: "North West", category: "area" },
    { name: "Yeshwanthpur", lat: 13.0057, lng: 77.5399, area: "North West", category: "area" },
    { name: "Kengeri", lat: 12.9071, lng: 77.4825, area: "South West", category: "area" },
    { name: "Nagarbhavi", lat: 12.9610, lng: 77.5110, area: "West", category: "area" },
    { name: "Basaveshwaranagar", lat: 12.9860, lng: 77.5390, area: "West", category: "area" },
    { name: "RT Nagar", lat: 13.0220, lng: 77.5960, area: "North", category: "area" },
    { name: "HBR Layout", lat: 13.0350, lng: 77.6150, area: "North", category: "area" },
    { name: "Hennur", lat: 13.0440, lng: 77.6340, area: "North East", category: "area" },
    { name: "Kalyan Nagar", lat: 13.0260, lng: 77.6390, area: "North East", category: "area" },
    { name: "HRBR Layout", lat: 13.0150, lng: 77.6210, area: "North East", category: "area" },
    { name: "Old Airport Road", lat: 12.9610, lng: 77.6470, area: "East", category: "area" },
    { name: "Outer Ring Road", lat: 12.9380, lng: 77.6850, area: "East", category: "area" },
    { name: "Mysore Road", lat: 12.9471, lng: 77.5095, area: "South West", category: "area" },
    { name: "Wilson Garden", lat: 12.9490, lng: 77.5920, area: "South", category: "area" },
    { name: "Langford Town", lat: 12.9460, lng: 77.5980, area: "South", category: "area" },
    { name: "Richmond Town", lat: 12.9620, lng: 77.6010, area: "Central", category: "area" },
    { name: "Bommanahalli", lat: 12.9020, lng: 77.6180, area: "South", category: "area" },
    { name: "Begur", lat: 12.8760, lng: 77.6310, area: "South", category: "area" },
    { name: "Kanakapura Road", lat: 12.8850, lng: 77.5690, area: "South", category: "area" },
    { name: "Tumkur Road", lat: 13.0350, lng: 77.5150, area: "North West", category: "area" },
    { name: "Hosur Road", lat: 12.8900, lng: 77.6400, area: "South", category: "area" },
    { name: "Frazer Town", lat: 12.9960, lng: 77.6120, area: "North East", category: "area" },
    { name: "Cantonment", lat: 12.9990, lng: 77.5960, area: "North", category: "area" },
    { name: "Hoskote", lat: 13.0707, lng: 77.7982, area: "East", category: "area" },
    { name: "Anekal", lat: 12.7105, lng: 77.6950, area: "South", category: "area" },
    { name: "Devanahalli", lat: 13.2468, lng: 77.7120, area: "North", category: "area" },

    // ── Hotels ──
    { name: "Taj West End", lat: 12.9650, lng: 77.5840, area: "Central", category: "hotel" },
    { name: "ITC Gardenia", lat: 12.9565, lng: 77.5955, area: "South", category: "hotel" },
    { name: "The Leela Palace", lat: 12.9614, lng: 77.6482, area: "East", category: "hotel" },
    { name: "The Oberoi", lat: 12.9700, lng: 77.6090, area: "Central", category: "hotel" },
    { name: "JW Marriott Bengaluru", lat: 12.9610, lng: 77.6448, area: "East", category: "hotel" },
    { name: "Radisson Blu Atria", lat: 12.9640, lng: 77.5780, area: "Central", category: "hotel" },
    { name: "Sheraton Grand Bangalore", lat: 12.9720, lng: 77.6070, area: "Central", category: "hotel" },
    { name: "Conrad Bengaluru", lat: 12.9558, lng: 77.6485, area: "East", category: "hotel" },
    { name: "Vivanta by Taj MG Road", lat: 12.9745, lng: 77.6085, area: "Central", category: "hotel" },
    { name: "Hilton Bangalore", lat: 13.0090, lng: 77.5510, area: "North West", category: "hotel" },
    { name: "Lemon Tree Whitefield", lat: 12.9740, lng: 77.7360, area: "East", category: "hotel" },
    { name: "Holiday Inn Racecourse", lat: 12.9790, lng: 77.5730, area: "Central", category: "hotel" },

    // ── Colleges & Universities ──
    { name: "Indian Institute of Science (IISc)", lat: 13.0219, lng: 77.5671, area: "North", category: "college" },
    { name: "Christ University", lat: 12.9348, lng: 77.6058, area: "South", category: "college" },
    { name: "RV College of Engineering", lat: 12.9237, lng: 77.4987, area: "South West", category: "college" },
    { name: "PES University", lat: 12.9344, lng: 77.5354, area: "South West", category: "college" },
    { name: "BMS College of Engineering", lat: 12.9413, lng: 77.5656, area: "South", category: "college" },
    { name: "MS Ramaiah Institute of Technology", lat: 13.0302, lng: 77.5650, area: "North", category: "college" },
    { name: "Jain University", lat: 12.9471, lng: 77.5820, area: "South", category: "college" },
    { name: "Mount Carmel College", lat: 12.9579, lng: 77.5988, area: "Central", category: "college" },
    { name: "St. Joseph's College", lat: 12.9478, lng: 77.5990, area: "South", category: "college" },
    { name: "Bangalore University", lat: 12.9387, lng: 77.5061, area: "West", category: "college" },
    { name: "NIFT Bangalore", lat: 13.0340, lng: 77.5670, area: "North", category: "college" },
    { name: "NLSIU (Law University)", lat: 12.9380, lng: 77.5060, area: "West", category: "college" },
    { name: "Reva University", lat: 13.1167, lng: 77.6344, area: "North", category: "college" },
    { name: "CMR University", lat: 13.0815, lng: 77.6755, area: "North East", category: "college" },
    { name: "Dayananda Sagar University", lat: 12.9070, lng: 77.5660, area: "South", category: "college" },

    // ── Schools ──
    { name: "Bishop Cotton Boys' School", lat: 12.9598, lng: 77.5963, area: "Central", category: "school" },
    { name: "National Public School Indiranagar", lat: 12.9740, lng: 77.6400, area: "East", category: "school" },
    { name: "Delhi Public School Bangalore East", lat: 12.9610, lng: 77.7060, area: "East", category: "school" },
    { name: "Mallya Aditi International School", lat: 13.0280, lng: 77.5770, area: "North", category: "school" },
    { name: "Inventure Academy", lat: 12.8630, lng: 77.6601, area: "South", category: "school" },
    { name: "The International School Bangalore", lat: 12.8520, lng: 77.6620, area: "South", category: "school" },
    { name: "Kumarans School", lat: 12.9520, lng: 77.5690, area: "South", category: "school" },
    { name: "Greenwood High School", lat: 12.9030, lng: 77.6510, area: "South East", category: "school" },

    // ── Restaurants ──
    { name: "MTR (Mavalli Tiffin Rooms)", lat: 12.9560, lng: 77.5750, area: "South", category: "restaurant" },
    { name: "Vidyarthi Bhavan", lat: 12.9440, lng: 77.5745, area: "South", category: "restaurant" },
    { name: "Toit Brewpub", lat: 12.9791, lng: 77.6407, area: "East", category: "restaurant" },
    { name: "Koshy's Restaurant", lat: 12.9730, lng: 77.6050, area: "Central", category: "restaurant" },
    { name: "Empire Restaurant", lat: 12.9770, lng: 77.5714, area: "Central", category: "restaurant" },
    { name: "Meghana Foods Koramangala", lat: 12.9340, lng: 77.6260, area: "South East", category: "restaurant" },
    { name: "Truffles Koramangala", lat: 12.9352, lng: 77.6170, area: "South East", category: "restaurant" },
    { name: "CTR (Central Tiffin Room)", lat: 12.9974, lng: 77.5715, area: "North West", category: "restaurant" },
    { name: "Brahmin's Coffee Bar", lat: 12.9530, lng: 77.5735, area: "South", category: "restaurant" },
    { name: "The Only Place", lat: 12.9708, lng: 77.6055, area: "Central", category: "restaurant" },
    { name: "Nagarjuna Restaurant", lat: 12.9649, lng: 77.5830, area: "Central", category: "restaurant" },
    { name: "By2Cup Indiranagar", lat: 12.9785, lng: 77.6380, area: "East", category: "restaurant" },

    // ── Tourist Places ──
    { name: "Lalbagh Botanical Garden", lat: 12.9507, lng: 77.5848, area: "South", category: "tourist" },
    { name: "Cubbon Park", lat: 12.9763, lng: 77.5929, area: "Central", category: "tourist" },
    { name: "Bangalore Palace", lat: 12.9988, lng: 77.5921, area: "North", category: "tourist" },
    { name: "ISKCON Temple", lat: 13.0104, lng: 77.5514, area: "North West", category: "tourist" },
    { name: "Tipu Sultan's Summer Palace", lat: 12.9594, lng: 77.5736, area: "South", category: "tourist" },
    { name: "Vidhana Soudha", lat: 12.9797, lng: 77.5909, area: "Central", category: "tourist" },
    { name: "Bannerghatta National Park", lat: 12.8007, lng: 77.5779, area: "South", category: "tourist" },
    { name: "Wonderla Amusement Park", lat: 12.8348, lng: 77.4009, area: "South West", category: "tourist" },
    { name: "Nandi Hills", lat: 13.3702, lng: 77.6835, area: "North", category: "tourist" },
    { name: "HAL Aerospace Museum", lat: 12.9580, lng: 77.6680, area: "East", category: "tourist" },

    // ── Hospitals ──
    { name: "Manipal Hospital (Old Airport Road)", lat: 12.9624, lng: 77.6478, area: "East", category: "hospital" },
    { name: "Narayana Health City", lat: 12.8820, lng: 77.5971, area: "South", category: "hospital" },
    { name: "Fortis Hospital Bannerghatta", lat: 12.8900, lng: 77.5990, area: "South", category: "hospital" },
    { name: "Apollo Hospital Jayanagar", lat: 12.9261, lng: 77.5846, area: "South", category: "hospital" },
    { name: "NIMHANS", lat: 12.9436, lng: 77.5949, area: "South", category: "hospital" },
    { name: "St. John's Hospital", lat: 12.9289, lng: 77.6213, area: "South East", category: "hospital" },
    { name: "Columbia Asia Hebbal", lat: 13.0350, lng: 77.5980, area: "North", category: "hospital" },
    { name: "Aster CMI Hospital", lat: 13.0390, lng: 77.6040, area: "North", category: "hospital" },
    { name: "Sakra World Hospital", lat: 12.9360, lng: 77.6770, area: "South East", category: "hospital" },
    { name: "BGS Gleneagles Hospital", lat: 12.9130, lng: 77.4980, area: "South West", category: "hospital" },

    // ── Malls ──
    { name: "Phoenix Marketcity", lat: 12.9975, lng: 77.6966, area: "East", category: "mall" },
    { name: "Orion Mall", lat: 13.0115, lng: 77.5554, area: "North West", category: "mall" },
    { name: "Forum Mall Koramangala", lat: 12.9345, lng: 77.6118, area: "South East", category: "mall" },
    { name: "Mantri Square Mall", lat: 12.9916, lng: 77.5683, area: "North West", category: "mall" },
    { name: "UB City Mall", lat: 12.9714, lng: 77.5964, area: "Central", category: "mall" },
    { name: "Garuda Mall", lat: 12.9705, lng: 77.6095, area: "Central", category: "mall" },
    { name: "VR Bengaluru", lat: 12.9929, lng: 77.7430, area: "East", category: "mall" },
    { name: "Lulu Mall Rajajinagar", lat: 12.9920, lng: 77.5510, area: "North West", category: "mall" },

    // ── Tech Parks ──
    { name: "Manyata Tech Park", lat: 13.0470, lng: 77.6210, area: "North", category: "tech_park" },
    { name: "RMZ Ecoworld", lat: 12.9280, lng: 77.6801, area: "South East", category: "tech_park" },
    { name: "Bagmane Tech Park", lat: 12.9650, lng: 77.6660, area: "East", category: "tech_park" },
    { name: "Embassy Tech Village", lat: 12.9270, lng: 77.6820, area: "South East", category: "tech_park" },
    { name: "Prestige Tech Park", lat: 12.9133, lng: 77.6364, area: "South East", category: "tech_park" },
    { name: "ITPL (International Tech Park)", lat: 12.9854, lng: 77.7314, area: "East", category: "tech_park" },
    { name: "Wipro Campus EC", lat: 12.8440, lng: 77.6580, area: "South", category: "tech_park" },
    { name: "Infosys Campus EC", lat: 12.8430, lng: 77.6600, area: "South", category: "tech_park" },
    { name: "RMZ Infinity", lat: 12.9610, lng: 77.6470, area: "East", category: "tech_park" },
    { name: "Global Village Tech Park", lat: 12.8940, lng: 77.6420, area: "South", category: "tech_park" },

    // ── Landmarks ──
    { name: "M. Chinnaswamy Stadium", lat: 12.9789, lng: 77.5999, area: "Central", category: "landmark" },
    { name: "City Railway Station", lat: 12.9753, lng: 77.5693, area: "Central", category: "landmark" },
    { name: "Kanteerava Stadium", lat: 12.9715, lng: 77.5955, area: "Central", category: "landmark" },
    { name: "Freedom Park", lat: 12.9770, lng: 77.5830, area: "Central", category: "landmark" },
    { name: "Town Hall", lat: 12.9709, lng: 77.5809, area: "Central", category: "landmark" },
    { name: "High Court of Karnataka", lat: 12.9800, lng: 77.5870, area: "Central", category: "landmark" },
    { name: "Ulsoor Lake", lat: 12.9830, lng: 77.6220, area: "Central", category: "landmark" },
    { name: "Hebbal Lake", lat: 13.0420, lng: 77.5910, area: "North", category: "landmark" },

    // ── Bus Stands ──
    { name: "Majestic Bus Stand (KSRTC)", lat: 12.9778, lng: 77.5725, area: "Central", category: "bus_stand" },
    { name: "Shantinagar Bus Stand (BMTC)", lat: 12.9550, lng: 77.6010, area: "Central", category: "bus_stand" },
    { name: "Kempegowda Bus Station", lat: 12.9770, lng: 77.5710, area: "Central", category: "bus_stand" },
    { name: "Banashankari BMTC Bus Stand", lat: 12.9165, lng: 77.5755, area: "South", category: "bus_stand" },
    { name: "Yeshwanthpur KSRTC Bus Stand", lat: 13.0076, lng: 77.5406, area: "North West", category: "bus_stand" },
    { name: "Satellite Bus Stand Mysore Road", lat: 12.9503, lng: 77.5010, area: "South West", category: "bus_stand" },

    // ── Airport ──
    { name: "Kempegowda International Airport (KIA)", lat: 13.1986, lng: 77.7066, area: "North", category: "landmark" },
  ];

  function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function findNearestStation(lat: number, lng: number, allStations: any[]) {
    let best = allStations[0], bestDist = Infinity;
    for (const s of allStations) {
      const d = haversineDistance(lat, lng, s.lat ?? 12.97, s.lng ?? 77.59);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return { station: best, distanceKm: parseFloat(bestDist.toFixed(1)) };
  }

  function findLocation(query: string) {
    const q = query.toLowerCase().trim();
    return BANGALORE_LOCATIONS.find(l => l.name.toLowerCase() === q)
      || BANGALORE_LOCATIONS.find(l => l.name.toLowerCase().includes(q))
      || BANGALORE_LOCATIONS.find(l => q.includes(l.name.toLowerCase()));
  }

  // Nominatim geocoding fallback for any location not in local DB
  async function geocodeWithNominatim(query: string): Promise<{ name: string; lat: number; lng: number } | null> {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + ", Bangalore, India")}&format=json&limit=1&addressdetails=1`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "METRO-MIND-Bangalore/1.0" },
      });
      const results = await resp.json() as any[];
      if (results.length > 0) {
        return {
          name: results[0].display_name.split(",")[0],
          lat: parseFloat(results[0].lat),
          lng: parseFloat(results[0].lon),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  function estimateFare(mode: string, distanceKm: number): number {
    switch (mode) {
      case "walk": return 0;
      case "bus": return Math.round(10 + distanceKm * 2);
      case "auto": return Math.round(30 + distanceKm * 14);
      case "cab": return Math.round(50 + distanceKm * 20);
      default: return 0;
    }
  }

  function estimateTime(mode: string, distanceKm: number): number {
    switch (mode) {
      case "walk": return Math.round(distanceKm * 12);
      case "bus": return Math.round(5 + distanceKm * 4);
      case "auto": return Math.round(3 + distanceKm * 3);
      case "cab": return Math.round(2 + distanceKm * 2.5);
      default: return 0;
    }
  }

  app.get("/api/route", async (req, res) => {
    try {
      const { from, to, sourceId, destId } = req.query;
      const allStations = await storage.getAllStations();

      let srcLoc: { name: string; lat: number; lng: number } | undefined;
      let dstLoc: { name: string; lat: number; lng: number } | undefined;

      // Support both location names and station IDs
      if (from && to) {
      let foundSrc: { name: string; lat: number; lng: number } | undefined = findLocation(from as string) ?? undefined;
      let foundDst: { name: string; lat: number; lng: number } | undefined = findLocation(to as string) ?? undefined;
        // Nominatim fallback for unknown locations
        if (!foundSrc) foundSrc = await geocodeWithNominatim(from as string) ?? undefined;
        if (!foundDst) foundDst = await geocodeWithNominatim(to as string) ?? undefined;
        if (!foundSrc || !foundDst) {
          return res.status(404).json({
            message: `Could not find location: ${!foundSrc ? from : to}`,
            suggestions: BANGALORE_LOCATIONS.map(l => l.name).slice(0, 20),
          });
        }
        srcLoc = foundSrc;
        dstLoc = foundDst;
      } else if (sourceId && destId) {
        const src = allStations.find(s => s.id === parseInt(sourceId as string));
        const dst = allStations.find(s => s.id === parseInt(destId as string));
        if (!src || !dst) return res.status(404).json({ message: "Station not found" });
        srcLoc = { name: src.name, lat: src.lat ?? 12.97, lng: src.lng ?? 77.59 };
        dstLoc = { name: dst.name, lat: dst.lat ?? 12.97, lng: dst.lng ?? 77.59 };
      } else {
        return res.status(400).json({ message: "Provide 'from' and 'to' location names, or 'sourceId' and 'destId'" });
      }

      const nearSrc = findNearestStation(srcLoc.lat, srcLoc.lng, allStations);
      const nearDst = findNearestStation(dstLoc.lat, dstLoc.lng, allStations);

      // Build metro leg
      const srcStation = nearSrc.station;
      const dstStation = nearDst.station;
      let metroStations: any[] = [];
      let metroTransfer = false;
      let transferStation: string | null = null;

      if (srcStation.line === dstStation.line) {
        const lineStations = allStations.filter(s => s.line === srcStation.line).sort((a, b) => a.orderIndex - b.orderIndex);
        const si = lineStations.findIndex(s => s.id === srcStation.id);
        const di = lineStations.findIndex(s => s.id === dstStation.id);
        const slice = lineStations.slice(Math.min(si, di), Math.max(si, di) + 1);
        if (si > di) slice.reverse();
        metroStations = slice;
      } else {
        const srcLine = allStations.filter(s => s.line === srcStation.line).sort((a, b) => a.orderIndex - b.orderIndex);
        const dstLine = allStations.filter(s => s.line === dstStation.line).sort((a, b) => a.orderIndex - b.orderIndex);
        const majSrc = srcLine.find(s => s.name === "Kempegowda Majestic");
        const majDst = dstLine.find(s => s.name === "Kempegowda Majestic");

        if (majSrc && majDst) {
          const si = srcLine.findIndex(s => s.id === srcStation.id);
          const mi = srcLine.findIndex(s => s.id === majSrc.id);
          let leg1 = srcLine.slice(Math.min(si, mi), Math.max(si, mi) + 1);
          if (si > mi) leg1.reverse();

          const mdi = dstLine.findIndex(s => s.id === majDst.id);
          const di = dstLine.findIndex(s => s.id === dstStation.id);
          let leg2 = dstLine.slice(Math.min(mdi, di), Math.max(mdi, di) + 1);
          if (mdi > di) leg2.reverse();

          metroStations = [...leg1, ...leg2.slice(1)];
          metroTransfer = true;
          transferStation = "Kempegowda Majestic";
        }
      }

      const metroTime = metroStations.length * 2 + (metroTransfer ? 5 : 0);
      const distKm = getDistanceKm(Number(srcStation.lat), Number(srcStation.lng), Number(dstStation.lat), Number(dstStation.lng));
      const metroFare = calculateBaseFare(distKm);

      const firstMileDist = nearSrc.distanceKm;
      const lastMileDist = nearDst.distanceKm;

      // Generate 3 route options
      const routes: any[] = [];

      // Route 1: FASTEST — Cab first/last mile
      const r1FirstMode = firstMileDist < 0.5 ? "walk" : "cab";
      const r1LastMode = lastMileDist < 0.5 ? "walk" : "cab";
      const r1Legs: any[] = [];
      if (firstMileDist > 0.15) {
        r1Legs.push({
          mode: r1FirstMode, from: srcLoc.name, to: `${srcStation.name} Metro`,
          duration: estimateTime(r1FirstMode, firstMileDist), fare: estimateFare(r1FirstMode, firstMileDist),
          instruction: r1FirstMode === "walk"
            ? `Walk from ${srcLoc.name} to ${srcStation.name} Metro Station (${firstMileDist} km)`
            : `Take a cab from ${srcLoc.name} to ${srcStation.name} Metro Station`,
          distanceKm: firstMileDist,
        });
      }
      r1Legs.push({
        mode: "metro", from: srcStation.name, to: dstStation.name,
        duration: metroTime, fare: metroFare,
        instruction: metroTransfer
          ? `Board ${srcStation.line === "purple" ? "Purple" : "Green"} Line → Transfer at Majestic → ${dstStation.line === "purple" ? "Purple" : "Green"} Line to ${dstStation.name}`
          : `Board ${srcStation.line === "purple" ? "Purple" : "Green"} Line from ${srcStation.name} to ${dstStation.name}`,
        stations: metroStations.map(s => ({ id: s.id, name: s.name, line: s.line, crowdLevel: s.crowdLevel })),
        transfer: metroTransfer, transferStation,
      });
      if (lastMileDist > 0.15) {
        r1Legs.push({
          mode: r1LastMode, from: `${dstStation.name} Metro`, to: dstLoc.name,
          duration: estimateTime(r1LastMode, lastMileDist), fare: estimateFare(r1LastMode, lastMileDist),
          instruction: r1LastMode === "walk"
            ? `Walk from ${dstStation.name} Metro Station to ${dstLoc.name} (${lastMileDist} km)`
            : `Take a cab from ${dstStation.name} Metro Station to ${dstLoc.name}`,
          distanceKm: lastMileDist,
        });
      }
      routes.push({
        type: "fastest", label: "⚡ Fastest Route",
        description: "Quickest door-to-door with cab + metro",
        totalTime: r1Legs.reduce((s, l) => s + l.duration, 0),
        totalFare: r1Legs.reduce((s, l) => s + l.fare, 0),
        legs: r1Legs,
      });

      // Route 2: CHEAPEST — Bus/Walk first/last mile
      const r2FirstMode = firstMileDist < 1.0 ? "walk" : "bus";
      const r2LastMode = lastMileDist < 1.0 ? "walk" : "bus";
      const r2Legs: any[] = [];
      if (firstMileDist > 0.15) {
        r2Legs.push({
          mode: r2FirstMode, from: srcLoc.name, to: `${srcStation.name} Metro`,
          duration: estimateTime(r2FirstMode, firstMileDist), fare: estimateFare(r2FirstMode, firstMileDist),
          instruction: r2FirstMode === "walk"
            ? `Walk from ${srcLoc.name} to ${srcStation.name} Metro Station (${firstMileDist} km)`
            : `Take BMTC bus from ${srcLoc.name} to ${srcStation.name} Metro Station`,
          distanceKm: firstMileDist,
        });
      }
      r2Legs.push({
        mode: "metro", from: srcStation.name, to: dstStation.name,
        duration: metroTime, fare: metroFare,
        instruction: metroTransfer
          ? `Board ${srcStation.line === "purple" ? "Purple" : "Green"} Line → Transfer at Majestic → ${dstStation.line === "purple" ? "Purple" : "Green"} Line to ${dstStation.name}`
          : `Board ${srcStation.line === "purple" ? "Purple" : "Green"} Line from ${srcStation.name} to ${dstStation.name}`,
        stations: metroStations.map(s => ({ id: s.id, name: s.name, line: s.line, crowdLevel: s.crowdLevel })),
        transfer: metroTransfer, transferStation,
      });
      if (lastMileDist > 0.15) {
        r2Legs.push({
          mode: r2LastMode, from: `${dstStation.name} Metro`, to: dstLoc.name,
          duration: estimateTime(r2LastMode, lastMileDist), fare: estimateFare(r2LastMode, lastMileDist),
          instruction: r2LastMode === "walk"
            ? `Walk from ${dstStation.name} Metro Station to ${dstLoc.name} (${lastMileDist} km)`
            : `Take BMTC bus from ${dstStation.name} Metro Station to ${dstLoc.name}`,
          distanceKm: lastMileDist,
        });
      }
      routes.push({
        type: "cheapest", label: "💰 Cheapest Route",
        description: "Most affordable with bus/walk + metro",
        totalTime: r2Legs.reduce((s, l) => s + l.duration, 0),
        totalFare: r2Legs.reduce((s, l) => s + l.fare, 0),
        legs: r2Legs,
      });

      // Route 3: BALANCED — Auto first mile, Bus last mile
      const r3FirstMode = firstMileDist < 0.5 ? "walk" : "auto";
      const r3LastMode = lastMileDist < 0.5 ? "walk" : lastMileDist < 2 ? "auto" : "bus";
      const r3Legs: any[] = [];
      if (firstMileDist > 0.15) {
        r3Legs.push({
          mode: r3FirstMode, from: srcLoc.name, to: `${srcStation.name} Metro`,
          duration: estimateTime(r3FirstMode, firstMileDist), fare: estimateFare(r3FirstMode, firstMileDist),
          instruction: r3FirstMode === "walk"
            ? `Walk from ${srcLoc.name} to ${srcStation.name} Metro Station (${firstMileDist} km)`
            : `Take an auto from ${srcLoc.name} to ${srcStation.name} Metro Station`,
          distanceKm: firstMileDist,
        });
      }
      r3Legs.push({
        mode: "metro", from: srcStation.name, to: dstStation.name,
        duration: metroTime, fare: metroFare,
        instruction: metroTransfer
          ? `Board ${srcStation.line === "purple" ? "Purple" : "Green"} Line → Transfer at Majestic → ${dstStation.line === "purple" ? "Purple" : "Green"} Line to ${dstStation.name}`
          : `Board ${srcStation.line === "purple" ? "Purple" : "Green"} Line from ${srcStation.name} to ${dstStation.name}`,
        stations: metroStations.map(s => ({ id: s.id, name: s.name, line: s.line, crowdLevel: s.crowdLevel })),
        transfer: metroTransfer, transferStation,
      });
      if (lastMileDist > 0.15) {
        r3Legs.push({
          mode: r3LastMode, from: `${dstStation.name} Metro`, to: dstLoc.name,
          duration: estimateTime(r3LastMode, lastMileDist), fare: estimateFare(r3LastMode, lastMileDist),
          instruction: r3LastMode === "walk"
            ? `Walk from ${dstStation.name} Metro Station to ${dstLoc.name} (${lastMileDist} km)`
            : r3LastMode === "auto"
              ? `Take an auto from ${dstStation.name} Metro Station to ${dstLoc.name}`
              : `Take BMTC bus from ${dstStation.name} Metro Station to ${dstLoc.name}`,
          distanceKm: lastMileDist,
        });
      }
      routes.push({
        type: "balanced", label: "⚖️ Best Value",
        description: "Good balance of time, comfort, and cost",
        totalTime: r3Legs.reduce((s, l) => s + l.duration, 0),
        totalFare: r3Legs.reduce((s, l) => s + l.fare, 0),
        legs: r3Legs,
      });

      res.json({
        from: srcLoc,
        to: dstLoc,
        nearestSourceStation: { name: srcStation.name, line: srcStation.line, distanceKm: nearSrc.distanceKm },
        nearestDestStation: { name: dstStation.name, line: dstStation.line, distanceKm: nearDst.distanceKm },
        routes,
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Route calculation failed" });
    }
  });

  // Location suggestions endpoint (with categories)
  app.get("/api/locations", (_req, res) => {
    res.json(BANGALORE_LOCATIONS.map(l => ({ name: l.name, area: l.area, category: l.category })));
  });

  // Geocode search endpoint — searches both local DB and Nominatim
  app.get("/api/geocode", async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== "string") return res.status(400).json({ results: [] });

      const query = q.toLowerCase().trim();
      // First search local DB
      const local = BANGALORE_LOCATIONS.filter(l =>
        l.name.toLowerCase().includes(query)
      ).slice(0, 5).map(l => ({ name: l.name, area: l.area, category: l.category, source: "local" }));

      // If we have enough local results, skip Nominatim
      if (local.length >= 3) return res.json({ results: local });

      // Nominatim fallback for richer results
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ", Bangalore, India")}&format=json&limit=${5 - local.length}&addressdetails=1`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "SmartAI-Metro-Bangalore/1.0" },
        });
        const results = await resp.json() as any[];
        const nominatim = results.map(r => ({
          name: r.display_name.split(",").slice(0, 2).join(",").trim(),
          area: r.address?.suburb || r.address?.neighbourhood || r.address?.city_district || "Bangalore",
          category: r.type || "place",
          source: "nominatim",
        }));
        res.json({ results: [...local, ...nominatim] });
      } catch {
        res.json({ results: local });
      }
    } catch {
      res.json({ results: [] });
    }
  });

  app.post("/api/tickets", requireAuth, async (req, res) => {
    try {
      const parsed = bookTicketSchema.parse(req.body);
      const source = await storage.getStation(parsed.sourceStationId);
      const dest = await storage.getStation(parsed.destStationId);
      if (!source || !dest) return res.status(404).json({ message: "Station not found" });

      const hour = new Date().getHours();
      const distKm = getDistanceKm(Number(source.lat), Number(source.lng), Number(dest.lat), Number(dest.lng));
      const demandLevel = getDemandLevel(hour, dest.crowdLevel);
      const multiplier = getPricingMultiplier(demandLevel);
      const baseFare = calculateBaseFare(distKm);
      // Apply multiplier and enforce ₹110 cap per person
      const dynamicFare = Math.min(110, Math.round(baseFare * multiplier));
      const totalFare = dynamicFare * parsed.passengers;

      if (parsed.paymentMethod === "wallet") {
        const user = await storage.getUserById(req.session.userId!);
        if (!user || user.walletBalance < totalFare) return res.status(400).json({ message: "Insufficient balance" });
        await storage.updateWalletBalance(user.id, user.walletBalance - totalFare);
      }

      const ticket = await storage.createTicket({
        userId: req.session.userId!,
        ...parsed,
        sourceName: source.name,
        destName: dest.name,
        baseFare,
        dynamicFare,
        totalFare,
        pricingMultiplier: multiplier,
        demandLevel,
        status: "active",
        qrData: null,
      });

      const qrPayload = JSON.stringify({ ticketId: ticket.id, source: source.name, dest: dest.name, totalFare });
      const qrDataUrl = await QRCode.toDataURL(qrPayload);
      await storage.updateTicket(ticket.id, { qrData: qrPayload });

      res.json({ ticket, qrDataUrl });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Booking failed" });
    }
  });

  app.get("/api/tickets/my", requireAuth, async (req, res) => { res.json(await storage.getUserTickets(req.session.userId!)); });

  app.post("/api/tickets/:id/cancel", requireAuth, async (req, res) => {
    try {
      const ticketId = String(req.params.id);
      const ticket = await storage.getTicket(ticketId);
      if (!ticket) return res.status(404).json({ message: "Ticket not found" });
      if (ticket.userId !== req.session.userId) return res.status(403).json({ message: "Not your ticket" });
      if (ticket.status !== "active") return res.status(400).json({ message: "Ticket is not active" });

      const cancelled = await storage.cancelTicketIfActive(ticketId);
      if (!cancelled) return res.status(400).json({ message: "Could not cancel ticket" });

      let refunded = false;
      let refundAmount = 0;
      if (ticket.paymentMethod === "wallet") {
        refundAmount = ticket.totalFare;
        const user = await storage.getUserById(req.session.userId!);
        if (user) {
          await storage.updateWalletBalance(user.id, user.walletBalance + refundAmount);
          await storage.createWalletTransaction(user.id, refundAmount, "credit", `Refund for cancelled ticket ${ticketId.slice(0, 8)}`);
          refunded = true;
        }
      }

      const updatedTicket = await storage.getTicket(ticketId);
      res.json({ ticket: updatedTicket, refunded, refundAmount });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Cancellation failed" });
    }
  });

  app.get("/api/tickets/:id/detail", requireAuth, async (req, res) => {
    try {
      const ticketId = String(req.params.id);
      const ticket = await storage.getTicket(ticketId);
      if (!ticket) return res.status(404).json({ message: "Ticket not found" });

      let qrDataUrl: string | null = null;
      if (ticket.qrData && ticket.status !== "cancelled" && ticket.status !== "used") {
        qrDataUrl = await QRCode.toDataURL(ticket.qrData);
      }
      res.json({ ticket, qrDataUrl });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Failed to get ticket details" });
    }
  });

  app.post("/api/scan", requireScanner, async (req, res) => {
    try {
      const parsed = scanTicketSchema.parse(req.body);
      const ticket = await storage.getTicket(parsed.ticketId);
      if (!ticket) return res.json({ valid: false, fraudDetected: false, message: "Ticket not found" });

      // Explicitly deny cancelled tickets with fraud-level alert
      if (ticket.status === "cancelled") {
        return res.json({
          valid: false,
          fraudDetected: true,
          fraudReason: "This ticket was cancelled and is no longer valid. Entry denied.",
          message: "🚫 CANCELLED TICKET — Entry Denied",
          ticket,
        });
      }

      if (ticket.status !== "active") {
        return res.json({ 
          valid: false, 
          fraudDetected: false,
          message: `Ticket is not active (Status: ${ticket.status})`, 
          ticket 
        });
      }

      const entryCount = ticket.entryCount ?? 0;
      const scanType = parsed.scanType || (entryCount < ticket.passengers ? "entry" : "exit");

      if (scanType === "entry" && entryCount >= ticket.passengers) {
        return res.json({ valid: false, fraudDetected: false, message: "All passengers for this ticket have already entered", ticket });
      }
      
      let updatedTicket;
      if (scanType === "entry") {
        await storage.updateTicket(ticket.id, { entryCount: entryCount + 1, scannedAt: new Date() });
        updatedTicket = await storage.getTicket(ticket.id);
      } else {
        const exitCount = (ticket.exitCount ?? 0) + 1;
        await storage.updateTicket(ticket.id, { exitCount, status: exitCount >= ticket.passengers ? "used" : "active" });
        updatedTicket = await storage.getTicket(ticket.id);
      }

      res.json({ valid: true, fraudDetected: false, message: "Scan successful", ticket: updatedTicket });
    } catch (error: any) {
      res.status(400).json({ message: error.message || "Scan failed" });
    }
  });

  // ── Admin Routes ──
  app.get("/api/admin/stats", requireAdmin, async (_req, res) => { res.json(await storage.getLivePassengerStats()); });
  app.get("/api/scans/recent", requireAdmin, async (_req, res) => { res.json(await storage.getRecentScans(20)); });

  // ── Insights ──
  app.get("/api/insights", async (_req, res) => {
    const allStations = await storage.getAllStations();
    const hour = new Date().getHours();

    // Make demand predictions genuinely dynamic based on busiest stations
    const sortedByCrowd = [...allStations].sort((a, b) => b.passengerCount - a.passengerCount);
    const topCrowded = sortedByCrowd.slice(0, 5);
    
    const demandPredictions = topCrowded.map((s) => {
      const isPeakNow = hour >= 8 && hour <= 10 || hour >= 17 && hour <= 19;
      // If peak now, prediction is high. If approaching peak, predicting surge. Otherwise cooling.
      let pred = "medium";
      let conf = 75 + Math.floor(Math.random() * 20);
      
      if (isPeakNow) pred = "high";
      else if (hour === 7 || hour === 16) { pred = "high"; conf = 85; }
      else if (s.crowdLevel === "high") pred = "medium"; // cooling down
      else pred = "low";

      return {
        station: s.name,
        currentLevel: s.crowdLevel,
        predictedLevel: pred,
        confidence: conf,
      };
    });

    // Generate AI-powered Recommendations
    let recommendations = [];
    try {
      const stationContext = allStations.map(s => `${s.name} (${s.line} line, ${s.crowdLevel} crowd)`).join(", ");
      const prompt = `Current System Time: ${hour}:00\nMetro Status: ${stationContext}\n\nPlease generate 3-5 travel tips for the users today. Return ONLY a valid JSON array of objects with keys: type (timing/route/pricing), title, description, impact.`;
      
      const result = await insightsModel.generateContent(prompt);
      const text = result.response.text();
      // Simple extraction in case JSON is wrapped in code blocks
      const jsonStr = text.match(/\[[\s\S]*\]/)?.[0] || text;
      recommendations = JSON.parse(jsonStr);
    } catch (error) {
      console.error("Gemini Insights Error:", error);
      // Fallback recommendations if AI fails
      recommendations = [
        { type: "timing", title: "Peak Hour Travel", description: "Trains are busiest between 8-10 AM and 5-7 PM.", impact: "Comfort" },
        { type: "pricing", title: "Smart Card Savings", description: "Use our digital wallet to save on every journey.", impact: "Save 10%" }
      ];
    }

    const highCrowdCount = allStations.filter((s) => s.crowdLevel === "high").length;
    const medCrowdCount = allStations.filter((s) => s.crowdLevel === "medium").length;
    const avgMultiplier = 1 + (highCrowdCount * 0.2 + medCrowdCount * 0.1) / Math.max(allStations.length, 1);

    const pricingInsights = {
      avgMultiplier: parseFloat(avgMultiplier.toFixed(2)),
      peakHours: ["8:00 AM – 10:00 AM", "5:00 PM – 7:00 PM"],
      revenueLift: parseFloat(((avgMultiplier - 1) * 100).toFixed(1)),
    };

    const anomalies: { type: string; description: string; severity: string; timestamp: string }[] = [];
    allStations.filter((s) => s.passengerCount > 800).forEach((s) => {
      anomalies.push({
        type: "crowd_spike",
        description: `Unusually high crowd at ${s.name} (${s.passengerCount} pax, ${(s.passengerCount/1000 * 100).toFixed(0)}% cap)`,
        severity: s.passengerCount > 1000 ? "critical" : "high",
        timestamp: new Date().toISOString(),
      });
    });

    // Generate mock historical trend data for the frontend chart
    const trendData = Array.from({ length: 9 }).map((_, i) => {
      const h = (hour - 8 + i + 24) % 24; // from 8 hours ago to now
      const isPeak = (h >= 8 && h <= 10) || (h >= 17 && h <= 19);
      const predictedVal = isPeak ? 75 + Math.random() * 20 : 30 + Math.random() * 30;
      
      // Calculate a realistic actual value that trails off into the future
      let actualVal: number | null = null;
      if (i <= 8) { // past data up to current hour
        actualVal = isPeak ? 80 + Math.random() * 15 : 25 + Math.random() * 35;
      }

      return {
        time: `${h.toString().padStart(2, '0')}:00`,
        predicted: Math.round(predictedVal),
        actual: actualVal ? Math.round(actualVal) : null
      };
    });

    res.json({ demandPredictions, recommendations, anomalies, pricingInsights, trendData });
  });

  return httpServer;
}
