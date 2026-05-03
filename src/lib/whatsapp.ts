export const isSafariBrowser = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/chrome|chromium|crios|android|fxios|edgios/i.test(ua);
};

export const normalizeWhatsAppPhone = (phone: string) => {
  const cleanPhone = (phone || "").replace(/\D/g, "");
  if (!cleanPhone) return null;
  return cleanPhone.startsWith("0") ? `972${cleanPhone.slice(1)}` : cleanPhone;
};

export const buildWhatsAppUrl = (phone: string, message: string) => {
  const intlPhone = normalizeWhatsAppPhone(phone);
  if (!intlPhone) return null;
  const encodedMessage = encodeURIComponent(message);
  return isSafariBrowser()
    ? `whatsapp://send?phone=${intlPhone}&text=${encodedMessage}`
    : `https://wa.me/${intlPhone}?text=${encodedMessage}`;
};

export const getWhatsAppMessageFromUrl = (url: string) => {
  const query = url.split("?")[1] || "";
  const text = new URLSearchParams(query).get("text");
  return text ? decodeURIComponent(text) : "";
};

export const copyWhatsAppMessageFromUrl = (url: string) => {
  const message = getWhatsAppMessageFromUrl(url);
  if (!message || !navigator.clipboard) return;
  navigator.clipboard.writeText(message).catch(() => undefined);
};

export const openWhatsAppUrl = (url: string) => {
  if (url.startsWith("whatsapp://")) {
    window.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};