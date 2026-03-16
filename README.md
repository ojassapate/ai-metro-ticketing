# METRO MIND - Bangalore Metro Ticketing System

A modern, full-stack, AI-powered web and mobile application for the Bangalore Namma Metro system. It provides a seamless interface for passengers to book tickets, plan multi-modal routes, analyze real-time crowd data, and get AI-assisted travel insights. Features an admin dashboard for operations monitoring and a comprehensive QR code validation system.

## ✨ Key Features

- **Smart Route Planner:** Plan journeys across the entire Purple and Green line network (68 stations). It calculates First & Last Mile connectivity (Auto, Cab, Bus, Walk) using a database of 150+ Bangalore POIs and Nominatim geocoding fallback. It suggests the Fastest, Cheapest, and Best Value routes.
- **AI Metro Assistant & Insights (Powered by Google Gemini):** An integrated chatbot that answers queries on timings, routes, fares, and crowd levels, and can accurately parse natural language booking intents. Additionally, the dashboard provides AI-generated travel tips and dynamic pricing insights based on live system load.
- **Dynamic Pricing Engine:** Fares automatically adjust based on distance, time of day (peak vs. off-peak), and real-time station congestion, encouraging off-peak travel while capping surge fares to protect passengers.
- **Real-Time Crowd Simulator:** Live, simulated passenger count and crowd levels ("low", "medium", "high") broadcasted to all active clients via WebSockets (Socket.IO).
- **Wallet & Transactions:** Built-in digital wallet for users to seamlessly add money, purchase tickets, and receive automatic refunds upon ticket cancellation.
- **Advanced Booking & Validation System:** Group bookings (up to 12 passengers), dynamic QR Code ticket generation, and a web-based QR Scanner with full lifecycle validation (Entry, Exit, Cancelled, Used). Built-in fraud detection alerts staff to invalid or cancelled tickets.
- **Live Admin Dashboard:** Real-time visibility into total bookings, active passengers inside the metro system, completed trips, fraud alerts, and a live log of recent scanner activity.
- **Multilingual Support:** Application UI is available in English, Kannada, and Hindi.
- **PWA (Progressive Web App):** Fully installable cross-platform app experience. Includes accessibility features, customizable themes (Dark/Light), and a live weather widget.

## 🛠️ Tech Stack

**Frontend:**
- React (18.x) + Vite + TypeScript
- Tailwind CSS + shadcn/ui components (Radix UI)
- Wouter (for lightweight routing)
- TanStack Query (React Query) for data fetching
- `html5-qrcode` & `qrcode` for QR scanning and generation
- Socket.IO-Client for real-time updates
- Vite PWA for Progressive Web App support

**Backend:**
- Express.js (Node.js 20.x) + TypeScript
- PostgreSQL (via `pg`) + Drizzle ORM
- Google Generative AI (Gemini Flash)
- Socket.IO for WebSockets
- `express-session` + `memorystore` for authentication management
- Zod for payload validation

## 🚀 Getting Started

### Prerequisites

- Node.js (v20+ recommended)
- A PostgreSQL server running locally or remotely
- A Google Gemini API Key

### Installation & Setup

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment Variables:**
   Create a `.env` file in the root directory and add the necessary variables:
   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/metro_db
   SESSION_SECRET=your_super_secret_session_key
   ADMIN_SECRET=admin_secret_key
   GOOGLE_GEMINI_API_KEY=your_gemini_api_key
   ```

3. **Database Setup & Seeding:**
   Push the Drizzle schema to your database first:
   ```bash
   npm run db:push
   ```
   *Note: On first server boot, the system automatically seeds all 68 Purple and Green line stations, along with Demo, Admin, and Scanner default user accounts.*

4. **Start the Development Server:**
   ```bash
   npm run dev
   ```

5. **Access the application:**
   Open your browser and navigate to `http://localhost:5000`.

### Default Accounts

During seeding, the following default accounts are created (Password: `demo123`):
- **User:** `demo@bmrcl.com`
- **Scanner:** `scanner@bmrcl.com`
- **Admin:** `admin@bmrcl.com`

### Building for Production

To create a production build and run the server:
```bash
npm run build
npm start
```
A Railway deployment configuration (`railway.json`) is also included.

## 🗺️ Application Structure

- `/client/src/pages/` - React components for the main views (Dashboard, Booking, Route Planner, Scanner, Tickets, Wallet, Maps, Insights, etc.)
- `/client/src/components/` - Reusable UI components (Sidebar, AI Chatbot, Weather Widget, Layout wrappers, Theme/Language providers, etc.)
- `/server/routes.ts` - Core Express backend routes, API controllers, Fare logic, Nominatim Geocoding, Gemini integration, and Admin metrics.
- `/server/storage.ts` - Database interface logic (using Drizzle ORM).
- `/server/crowd-simulator.ts` & `/server/seed.ts` - Autonomous scripts for simulating live workloads and initializing app states.
- `/shared/schema.ts` - Shared Zod schemas and Drizzle tables used by both the frontend and backend for end-to-end type safety.

## 📄 License

This project is licensed under the MIT License.
