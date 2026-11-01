# Enforcement

What to do when Argus, or a substantial part of it, appears somewhere under another name or without permission. Written so the author can act in ten minutes rather than a weekend. The rights relied on are in [LICENSE](LICENSE), [USE-POLICY.md](USE-POLICY.md) and [TRADEMARK.md](TRADEMARK.md).

## 1. Capture evidence first

Before contacting anyone, so the copy cannot quietly change:

1. Save the page: full page PDF or screenshot with the address bar and the date visible.
2. Archive it at web.archive.org and keep the archived link.
3. If it is a git repository, clone it and record `git log --format='%H %ad %an' --date=iso` for the copied files.
4. Note the matching passages: at least three distinctive sentences, file names or test names that appear in both. Distinctive means unlikely to be written independently; the ADR numbering, the 408-assertion suite, the runbook titles and the console screen names are good candidates.
5. Record the commit in this repository where each matched passage first appeared: `git log -S'<sentence>' --format='%H %ad' --date=iso -- <path>`.
6. Put all of it in a dated folder outside this repository.

## 2. Decide which route

| What you found | Route |
| --- | --- |
| A copy on GitHub, GitLab, Bitbucket, npm, PyPI, Docker Hub | Platform copyright notice (section 3) |
| A copy or substantial excerpt in a LinkedIn post, Medium article, blog, YouTube video, course or slide deck | Platform copyright notice, or a direct notice to the author first if the platform has no form |
| A product, company or domain using the Argus name | Direct notice (section 4), then the registrar or platform |
| A copy that keeps the MIT era notice and your name, from before 1 November 2026 | Allowed. Check that the MIT notice and copyright line are intact; if not, treat as a copy without permission |
| A paraphrase of the ideas with no copied text | Not infringement. Ask for attribution politely; nothing more |
| Someone claiming to be the author, or your name used to endorse something | Direct notice, then the platform's impersonation form |

## 3. Platform copyright notice

Every large platform takes down copies on a copyright notice (in the United States this is the DMCA; the EU, the United Kingdom and most other countries have an equivalent). It is a short form, costs nothing, and usually acts within days. Submit the notice from the account or email that matches the author named in this repository.

Where the forms are:

- GitHub: https://github.com/contact/dmca
- GitLab: https://about.gitlab.com/handbook/dmca/
- npm: https://docs.npmjs.com/policies/dmca
- Docker Hub: https://www.docker.com/legal/
- LinkedIn: Help Centre, *Notice of Copyright Infringement*
- Medium: https://policy.medium.com/
- YouTube: https://www.youtube.com/copyright_complaint_form
- Google Search, Blogger, Drive, Sites: https://support.google.com/legal
- Any other site: look for "copyright", "DMCA" or "legal" in the footer, or email abuse@ the domain

### Notice template

Fill the bracketed parts. Keep it factual; do not add threats or opinions.

```
Subject: Copyright infringement notice: Argus

I am Adil Munawar, the author and copyright owner of the work "Argus"
published at https://github.com/Adilmunawar/argus and licensed under its
LICENSE file, which reserves all rights and permits no copying or
redistribution without my written permission.

Infringing material:
  [URL of the copy, one per line]

Original work:
  https://github.com/Adilmunawar/argus/blob/main/[path]
  First published [date], see commit [hash].

The infringing material reproduces the following from the original:
  [three or more matching passages, file names or sections, quoted]

I have a good faith belief that the use of the material described above is
not authorised by me, by any agent of mine, or by law. The information in
this notice is accurate, and under penalty of perjury I am the owner of an
exclusive right that is allegedly infringed.

Please remove or disable access to the infringing material.

Adil Munawar
https://github.com/Adilmunawar
adilmunawarx@gmail.com
[postal address, required by most forms]
[date]
[signature: typed full name]
```

If the host asks whether you consent to the jurisdiction of their courts for a counter notice, that is standard and the form will not submit without it.

### If a counter notice arrives

The copy may be restored after ten to fourteen business days unless you file a court action in that time. At that point talk to a lawyer; a counter notice is the other party saying they will stand behind their claim in court.

## 4. Direct notice

For a product, company, domain, conference talk or anything with no takedown form, write to the person or organisation first. One email, polite, with a deadline.

```
Subject: Argus: use without permission

I am the author of Argus (https://github.com/Adilmunawar/argus). [What you
found] at [URL] reproduces [what] from it. Argus is not open source; its
licence requires my written permission for any use, and no permission has
been given.

Please, within 7 days:
  1. remove the material, or
  2. restore my name and copyright notice and reply to ask for permission
     under https://github.com/Adilmunawar/argus/blob/main/USE-POLICY.md.

If I do not hear from you I will file a copyright notice with [platform /
registrar / host] and consider further steps.

Adil Munawar
```

## 5. Going further

A platform notice removes a copy. It does not compensate you. Suing is a decision to make with a lawyer in the infringer's jurisdiction, and it is worth it when:

- the copy is commercial, or the copier is a company;
- you can show loss, or you hold a US copyright registration made before the infringement or within three months of first publication, which unlocks statutory damages and fees there;
- the evidence folder from section 1 is complete.

Steps that make that day cheaper, done in advance:

- **Archive each release on Zenodo** for a DOI and an independent timestamp. Add the DOI to CITATION.cff.
- **Sign commits and tags** with a key held only by you, then require signed commits on `main` in the repository settings.
- **Register the copyright** in the United States at copyright.gov if US enforcement is plausible. One registration per release is enough.
- **Keep this repository's history intact.** Never rewrite or squash `main`; the dated commits are the primary evidence.

## 6. Monitoring

Monthly, or when a release ships:

1. GitHub code search for three distinctive sentences from the ADRs and the console tests, in quotes.
2. Google, in quotes, for the same sentences and for `"Argus" "sovereign private cloud"`.
3. Review the fork list at https://github.com/Adilmunawar/argus/forks. A fork is allowed; a fork with the licence or author changed is not.
4. Search npm, PyPI and Docker Hub for `argus-console`, `argus-cloud` and `argus-platform`.
5. Set a Google Alert for two of the sentences once and leave it running.

## 7. Log

Record every action here, newest first, so the history of enforcement is as traceable as the history of the design.

| Date | Where | What was copied | Route | Outcome |
| --- | --- | --- | --- | --- |
| | | | | |
