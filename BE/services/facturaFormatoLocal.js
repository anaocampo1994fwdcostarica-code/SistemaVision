function formatearMonto(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const [entero, decimal] = Number(n).toFixed(2).split('.');
  return `${entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${decimal}`;
}
module.exports = { formatearMonto };
