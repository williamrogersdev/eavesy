export function sameNetwork(a: string, b: string): boolean {
  if (a.includes(':') && b.includes(':')) {
    const prefix = (ip: string) => expandV6(ip).slice(0, 4).join(':');
    return prefix(a) === prefix(b);
  }
  return a === b;
}

function expandV6(ip: string): string[] {
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? Array<string>(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].map((part) => part.replace(/^0+(?=.)/, ''));
}
