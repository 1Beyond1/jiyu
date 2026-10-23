export function shareAddress(origin: string) {
  const url = new URL(origin), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host)
  const lan = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host.endsWith('.lan') || host.includes(':') && /^(f[cd]|fe[89ab])/i.test(host)
  if (local) return { kind: 'local', label: '仅本机可访问', detail: '这个链接只能在当前服务器或电脑上打开，发给别人无法使用。对外收集前，请配置域名、HTTPS 和访问地址。' } as const
  if (lan) return { kind: 'lan', label: '局域网地址', detail: '通常仅同一局域网或 VPN 内可访问。发给其他人之前，请先确认他们能打开这个链接。' } as const
  if (url.protocol !== 'https:') return { kind: 'http', label: '尚未启用 HTTPS', detail: '当前链接使用 HTTP。对外收集前，请配置 HTTPS，保护文件与提交信息。' } as const
  return { kind: 'external', label: '外部地址，待实测', detail: '请用另一台设备或手机移动网络打开链接并试交文件，确认外部可以访问。' } as const
}
