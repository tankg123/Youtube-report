import axios from "axios";
import { SESSION_ENDED_EVENT, keepsPageOnSessionEnd, loginPathFor } from "../utils/returnTo";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4015/api";
const BACKEND_API_KEY = import.meta.env.VITE_BACKEND_API_KEY || "";

const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
  headers: {
    "x-api-key": BACKEND_API_KEY
  }
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  if (BACKEND_API_KEY) {
    config.headers["x-api-key"] = BACKEND_API_KEY;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      localStorage.removeItem("token_expires_at");

      const { pathname } = window.location;
      if (keepsPageOnSessionEnd(pathname)) {
        // a stand-alone tool (/pdf) holds unsaved work in memory: it stays, and AuthContext drops the user
        window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
      } else if (!pathname.includes("/login")) {
        window.location.href = loginPathFor(pathname);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
