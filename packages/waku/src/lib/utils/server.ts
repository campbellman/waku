export function getDevPort() {
  return parseInt(process.env.PORT || '3000', 10);
}

export function getPrdPort() {
  return parseInt(process.env.PORT || '8080', 10);
}
