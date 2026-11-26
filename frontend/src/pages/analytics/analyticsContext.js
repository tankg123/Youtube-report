import { createContext } from "react";

// Filled by AnalyticsProvider.jsx (one per /analytic shell); read through useAnalytics() from hooks.js.
export const AnalyticsContext = createContext(null);
