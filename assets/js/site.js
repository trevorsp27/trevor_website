(function () {
  const config = window.SITE_CONFIG;
  if (!config) {
    return;
  }

  const isHome = document.body.dataset.page === "home";
  const currentPage = document.body.dataset.page || "";

  const yearTarget = document.querySelector("[data-year]");
  if (yearTarget) {
    yearTarget.textContent = String(new Date().getFullYear());
  }

  const siteNameTargets = document.querySelectorAll("[data-site-name]");
  siteNameTargets.forEach((node) => {
    node.textContent = config.siteName;
  });

  const ownerTargets = document.querySelectorAll("[data-owner]");
  ownerTargets.forEach((node) => {
    node.textContent = config.ownerName;
  });

  const taglineTargets = document.querySelectorAll("[data-tagline]");
  taglineTargets.forEach((node) => {
    node.textContent = config.tagline;
  });

  const navTarget = document.querySelector("[data-nav]");
  if (navTarget) {
    const items = [
      {
        id: "home",
        title: "About",
        path: isHome ? "#top" : "../index.html"
      },
      ...config.pages
    ];

    navTarget.innerHTML = items
      .map((item) => {
        const isActive = item.id === currentPage;
        return `<li><a href="${item.path}" class="nav-link${
          isActive ? " is-active" : ""
        }">${item.title}</a></li>`;
      })
      .join("");
  }

  const cardsTarget = document.querySelector("[data-page-cards]");
  if (cardsTarget) {
    cardsTarget.innerHTML = config.pages
      .map(
        (page) => `
        <article class="interest-card reveal">
          <p class="card-kicker">${page.icon}</p>
          <h3>${page.title}</h3>
          <p>${page.summary}</p>
          <a href="${page.path}" class="inline-link">Open page</a>
        </article>
      `
      )
      .join("");
  }

  const aboutIntro = document.querySelector("[data-about-intro]");
  if (aboutIntro) {
    aboutIntro.textContent = config.about.intro;
  }

  const aboutDetails = document.querySelector("[data-about-details]");
  if (aboutDetails) {
    aboutDetails.innerHTML = config.about.details
      .map((item) => `<li>${item}</li>`)
      .join("");
  }

  const emailLink = document.querySelector("[data-email]");
  if (emailLink) {
    emailLink.textContent = config.email;
    emailLink.href = `mailto:${config.email}`;
  }

  const githubLink = document.querySelector("[data-github]");
  if (githubLink) {
    githubLink.href = config.githubUrl;
  }

  const linkedInLink = document.querySelector("[data-linkedin]");
  if (linkedInLink && config.linkedInUrl) {
    linkedInLink.href = config.linkedInUrl;
  }
})();
