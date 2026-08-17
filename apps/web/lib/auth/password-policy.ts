export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_MIN_LENGTH_MESSAGE = "Sua senha precisa ter pelo menos 8 caracteres.";
export const PASSWORD_CONFIRMATION_MESSAGE = "As senhas não coincidem.";

export function validateNewPassword(password: string, confirmation?: string) {
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_MIN_LENGTH_MESSAGE;
  if (confirmation !== undefined && password !== confirmation) return PASSWORD_CONFIRMATION_MESSAGE;
  return null;
}

export function friendlyAuthError(error: unknown, operation: "login" | "signup" | "recovery" | "reset") {
  const candidate = error as { code?: string; message?: string; status?: number } | null;
  const code = candidate?.code ?? "";
  const message = candidate?.message?.toLowerCase() ?? "";
  if (code === "weak_password") return PASSWORD_MIN_LENGTH_MESSAGE;
  if (code === "user_already_exists" || message.includes("already registered")) return "Já existe uma conta com este e-mail. Entre na sua conta ou recupere sua senha.";
  if (code === "email_address_invalid" || message.includes("invalid email")) return "Digite um e-mail válido.";
  if (candidate?.status === 429 || message.includes("rate limit")) return "Muitas tentativas foram realizadas. Aguarde um pouco e tente novamente.";
  if (message.includes("fetch") || message.includes("network")) return "Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.";
  if (operation === "login") return "E-mail ou senha inválidos.";
  return "Não foi possível concluir agora. Tente novamente em alguns instantes.";
}
