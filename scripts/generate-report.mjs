const port = process.env.PORT || 8787;
const res = await fetch(`http://localhost:${port}/api/report`);
if (!res.ok) throw new Error(`report failed: ${res.status}`);
const json = await res.json();
console.log(json.markdown);
