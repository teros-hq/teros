# SEO & Metadata Configuration Guide

This document describes the SEO and metadata implementation for the Teros platform.

## Overview

Comprehensive SEO metadata has been added to improve search engine positioning and social media previews.

## Files Modified

### 1. `/public/index.html`
Main HTML template with complete metadata tags.

**Added:**
- **SEO Meta Tags**: description, keywords, author, robots
- **Open Graph Tags**: og:title, og:description, og:image, og:url, og:type, og:locale
- **Twitter Card Tags**: twitter:card, twitter:title, twitter:description, twitter:image
- **Canonical URL**: Link to canonical version of the page
- **Structured Data**: JSON-LD schema for SoftwareApplication

### 2. `/public/manifest.json`
PWA manifest with enhanced metadata.

**Updated:**
- Enhanced name and description
- Added scope
- Added business category

### 3. `/app.config.js`
Expo configuration for web platform.

**Updated:**
- Enhanced web description
- Updated theme color to match dark theme (#000000)
- Added lang property

### 4. `/public/robots.txt` (New)
Search engine crawler directives.

**Content:**
- Allows all user agents
- References sitemap location
- Sets crawl delay to 1 second

### 5. `/public/sitemap.xml` (New)
XML sitemap for search engines.

**Pages included:**
- Homepage (priority 1.0)
- Login page (priority 0.8)

## Key Metadata Values

| Property | Value |
|----------|-------|
| **Title** | Teros - Asistentes IA Personalizables |
| **Description** | Plataforma de asistentes IA con capacidades avanzadas. Automatiza tareas, gestiona proyectos y potencia tu productividad. |
| **Keywords** | IA, asistente virtual, automatización, productividad, agentes IA, Teros, AI assistant, workspace |
| **OG Image** | https://os.teros.ai/icon-512.png |
| **Twitter Card** | summary_large_image |
| **Locale** | es_ES (primary), en_US (alternate) |
| **Theme Color** | #000000 (dark theme) |

## Social Media Preview

When shared on social media platforms, the link will display:
- **Title**: Teros - Asistentes IA Personalizables
- **Description**: Plataforma de asistentes IA con capacidades avanzadas...
- **Image**: 512x512px Teros logo (icon-512.png)
- **Card Type**: Large image card (Twitter)

## Structured Data (Schema.org)

The page includes JSON-LD structured data identifying Teros as a:
- **Type**: SoftwareApplication
- **Category**: ProductivityApplication
- **Operating Systems**: Web, iOS, Android
- **Price**: Free (0 USD)

## Testing

To verify the implementation:

1. **Google Rich Results Test**: https://search.google.com/test/rich-results
2. **Facebook Sharing Debugger**: https://developers.facebook.com/tools/debug/
3. **Twitter Card Validator**: https://cards-dev.twitter.com/validator
4. **LinkedIn Post Inspector**: https://www.linkedin.com/post-inspector/

## Future Improvements

Consider adding:
- Dynamic sitemap generation based on public routes
- Additional structured data for specific features
- Multi-language metadata support
- Open Graph images optimized for different platforms (1200x630px for Facebook)
- Screenshots in manifest.json for PWA store listings

## Maintenance

- Update sitemap.xml when adding new public pages
- Update lastmod dates in sitemap after significant changes
- Verify metadata after major releases
- Monitor search console for indexing issues

---

**Last Updated**: 2026-02-12  
**Version**: 1.0.0
