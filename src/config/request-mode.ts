const MANUAL_REFRESH_ENV = (import.meta.env.VITE_MANUAL_REFRESH_ONLY ?? 'false').toString().trim().toLowerCase();

/**
 * Manual refresh mode disables periodic network polling and relies on
 * explicit user-triggered refresh actions.
 */
export const MANUAL_REFRESH_ONLY = MANUAL_REFRESH_ENV !== 'false';
