export const metadata = {
  title: "Contact | Acme Plumbing",
  description: "Call or email Acme Plumbing for a free quote.",
};

export default function Contact() {
  return (
    <>
      <h1>Contact us</h1>
      <p>
        Phone: <a href="tel:+15550142">555-0142</a>
      </p>
      <p>
        Email: <a href="mailto:hello@acme-plumbing.example.com">hello@acme-plumbing.example.com</a>
      </p>
      <p>Address: 100 Main Street, Springfield</p>
      <p>Hours: Monday to Saturday, 7am to 6pm</p>
    </>
  );
}
