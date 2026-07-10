const CONTACT_EMAIL = "pingatou@gmail.com";
const LINE_ID = "0903247221";

const header = document.querySelector("[data-header]");
const form = document.querySelector("#contact");
const lineInput = document.querySelector("#lineId");
const phoneInput = document.querySelector("#phone");
const interestInput = document.querySelector("#interest");
const consentInput = document.querySelector("#consent");
const statusText = document.querySelector("#formStatus");
const copyButton = document.querySelector("#copyLead");

let latestLeadText = "";

function setHeaderState() {
  header.classList.toggle("is-scrolled", window.scrollY > 12);
}

function normalizePhone(value) {
  return value.replace(/[()\s-]/g, "");
}

function isValidTaiwanMobile(value) {
  const normalized = normalizePhone(value);
  return /^(09\d{8}|\+?8869\d{8})$/.test(normalized);
}

function setFieldError(input, message) {
  const field = input.closest(".field");
  const error = field?.querySelector(".field-error");

  field?.classList.toggle("is-invalid", Boolean(message));
  input.setAttribute("aria-invalid", message ? "true" : "false");

  if (error) {
    error.textContent = message;
  }
}

function validateForm() {
  const lineValue = lineInput.value.trim();
  const phoneValue = phoneInput.value.trim();
  let isValid = true;

  if (lineValue.length < 3) {
    setFieldError(lineInput, "請填寫有效的 LINE ID。");
    isValid = false;
  } else {
    setFieldError(lineInput, "");
  }

  if (!isValidTaiwanMobile(phoneValue)) {
    setFieldError(phoneInput, "請填寫台灣手機號碼，例如 09xx xxx xxx。");
    isValid = false;
  } else {
    setFieldError(phoneInput, "");
  }

  if (!consentInput.checked) {
    statusText.textContent = "請勾選同意後再送出。";
    isValid = false;
  }

  return isValid;
}

function buildLead() {
  const now = new Date();

  return {
    lineId: lineInput.value.trim(),
    phone: phoneInput.value.trim(),
    interest: interestInput.value,
    submittedAt: now.toLocaleString("zh-TW", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

function formatLead(lead) {
  return [
    "Vecto OPC 諮詢名單",
    `LINE ID：${lead.lineId}`,
    `手機：${lead.phone}`,
    `需求：${lead.interest}`,
    `時間：${lead.submittedAt}`,
    "",
    `請回覆此名單，或請對方加 LINE：${LINE_ID}`,
  ].join("\n");
}

function buildMailtoUrl(lead) {
  const subject = `Vecto OPC 諮詢名單 - ${lead.phone}`;
  const body = formatLead(lead);
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function submitLead(lead) {
  localStorage.setItem("vecto-opc-lead", JSON.stringify(lead));
  window.location.href = buildMailtoUrl(lead);
  return { ok: true };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusText.textContent = "";

  if (!validateForm()) {
    copyButton.hidden = true;
    return;
  }

  const lead = buildLead();
  const result = await submitLead(lead);

  if (!result.ok) {
    statusText.textContent = "送出失敗，請稍後再試。";
    copyButton.hidden = true;
    return;
  }

  latestLeadText = formatLead(lead);
  statusText.textContent = `已開啟郵件 App，收件人為 ${CONTACT_EMAIL}。請確認寄出，或直接加 LINE：${LINE_ID}。`;
  copyButton.hidden = false;
  form.reset();
});

copyButton.addEventListener("click", async () => {
  if (!latestLeadText) {
    return;
  }

  try {
    await navigator.clipboard.writeText(latestLeadText);
    statusText.textContent = "聯絡卡已複製。";
  } catch {
    statusText.textContent = latestLeadText;
  }
});

[lineInput, phoneInput].forEach((input) => {
  input.addEventListener("input", () => setFieldError(input, ""));
});

consentInput.addEventListener("change", () => {
  if (consentInput.checked) {
    statusText.textContent = "";
  }
});

window.addEventListener("scroll", setHeaderState, { passive: true });
setHeaderState();
