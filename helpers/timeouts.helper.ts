/**
 * Global timeouts configuration (in milliseconds).
 * Adjust these values to globally speed up or slow down tests depending on environment speed.
 */
export const Timeouts = {

  // 5 second (e.g., waiting for dialogs, transitions, dropdown menus)
  SHORT: 5000,

  // 10 seconds (e.g., standard page navigation, basic URL redirects, form validations)
  MEDIUM: 10000,

  // 30 seconds (e.g., waiting for elements to render, typical toast messages)
  LONG: 30000,

  // 60 seconds (e.g., waiting for slow API response toast notifications)
  VERY_LONG: 60000,

  // 180 seconds (e.g., slow redirects, initial login form submissions, complex processes)
  EXTRA_LONG: 180000,
} as const;

export const {
  SHORT: SHORT_WAIT,
  MEDIUM: MEDIUM_WAIT,
  LONG: LONG_WAIT,
  VERY_LONG: VERY_LONG_WAIT,
  EXTRA_LONG: EXTRA_LONG_WAIT,
} = Timeouts;
