export const metadata = {
  title: "Services | Acme Plumbing",
  description: "Emergency repair, water heater installation and drain cleaning.",
};

const services = [
  { name: "Emergency repair", price: "From $149", text: "Burst pipes and leaks, any hour." },
  { name: "Water heater install", price: "From $1,200", text: "Tank and tankless units." },
  { name: "Drain cleaning", price: "From $99", text: "Kitchen, bath and main line." },
];

export default function Services() {
  return (
    <>
      <h1>Our services</h1>
      {services.map((s) => (
        <section key={s.name}>
          <h2>{s.name}</h2>
          <p>
            {s.text} <strong>{s.price}</strong>
          </p>
        </section>
      ))}
    </>
  );
}
