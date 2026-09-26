'use client';

import { useEffect } from 'react';

/**
 * Starts the app controller (src/main.js) once, in the browser, after the server-rendered markup
 * has hydrated. It is loaded dynamically so wallet, canvas and price code never run on the server.
 */
export default function AppController() {
  useEffect(() => {
    import('../main.js').then(({ startApp }) => startApp());
  }, []);
  return null;
}
