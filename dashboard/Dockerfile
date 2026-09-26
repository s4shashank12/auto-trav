# The dashboard as a container, for running the whole stack locally
# (deploy/docker-compose.local.yml). In production it is served by Firebase Hosting instead.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Shown in the top bar, and the backend URL the connect form suggests.
ARG VITE_APP_VERSION=dev
ARG VITE_API_URL=
ENV VITE_APP_VERSION=$VITE_APP_VERSION \
    VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
