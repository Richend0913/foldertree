const PLACEHOLDER = 'YOUR-KOFI-NAME';

// A link only appears once it has a real address. See "Replacing the Ko-fi link"
// in the README.
export const isConfiguredUrl = (url) => Boolean(url) && !url.includes(PLACEHOLDER);
