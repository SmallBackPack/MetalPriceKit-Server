//
//  num.ts
//  MetalPriceKit Server
//  数值工具。四舍五入。
//
//  为什么单独一个文件：价格、汇率、涨跌幅都要四舍五入，
//  而上游适配层不该依赖行情层（方向是行情层在上游层之上）。
//  放这里，两边都能用，依赖方向也不拧巴。
//

/**
 * 按 scale 四舍五入，避免下发 14,306.866100000001 这种浮点噪声。
 *
 * 不能直接 Math.round(value * 10 ** scale)：IEEE754 下 1.005 * 100 是
 * 100.49999999999999，四舍五入会得到 1.00 而不是 1.01。
 * 先用指数写法把小数点挪到末尾（'1.005e2' 精确等于 100.5）再取整，绕开这个误差。
 */
export function roundTo(value: number, scale: number): number {
  if (!Number.isFinite(value)) return value;
  const shifted = Number(`${value}e${scale}`);
  if (!Number.isFinite(shifted)) {
    // 极端量级下指数写法会溢出（'1e21e2' 非法），退回普通写法。
    const factor = 10 ** scale;
    return Math.round(value * factor) / factor;
  }
  // Math.round 对 .5 是「向 +∞ 取整」，负数要手动按「远离零」取整，
  // 否则 -1.005 会变成 -1.00 而 +1.005 变成 1.01，两边不对称。
  const magnitude = Math.round(Math.abs(shifted));
  const rounded = shifted < 0 ? -magnitude : magnitude;
  return Number(`${rounded}e${-scale}`);
}
