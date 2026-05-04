const port = process.env.PORT || 8787;
const cookie = process.env.COOKIE || (process.env.PET_SESSION ? `pet_session=${process.env.PET_SESSION}` : "");

const res = await fetch(`http://localhost:${port}/api/report`, {
  headers: cookie ? { cookie } : undefined,
});

if (!res.ok) throw new Error(`report failed: ${res.status}`);
const json = (await res.json()) as { markdown?: string };
console.log(json.markdown || "");
