import axios from "axios";

// Replace with your actual Worker URL when deploying
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

// Generate a random user ID for simulation
const getUserId = () => {
  let uid = localStorage.getItem("lottery_uid");
  if (!uid) {
    uid = "user_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("lottery_uid", uid);
  }
  return uid;
};

const req = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
  headers: {
    "x-user-id": getUserId(),
  },
});

export const api = {
  research: () => req.get("/api/research"),
  researchResults: (run_ids) => req.post("/api/research-results", { run_ids }),
  // Predict
  predict: (data) => req.post("/api/predict", data),

  // Predict multiple diversified plans
  predictBundle: (data) => req.post("/api/predict-bundle", data),

  // Backtest strategies
  backtest: (data) => req.post("/api/backtest", data),

  // Save
  savePrediction: (data) => req.post("/api/save-prediction", data),

  // History
  getHistory: (params) => req.get("/api/history", { params }),

  // Trigger Fetch (Optional/Debug)
  fetchResults: () => req.get("/api/fetch-results"),
};
