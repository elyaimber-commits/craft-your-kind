import { useLocation, Navigate } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  // Auto-redirect to home page to handle edge cases (e.g. WhatsApp in-app browser, PWA cache)
  return <Navigate to="/" replace />;
};

export default NotFound;
