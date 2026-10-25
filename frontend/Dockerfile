FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_REVIEW_ID=
ARG VITE_API_URL=/api
ARG VITE_CONNECTED_MODE=false
ENV VITE_REVIEW_ID=$VITE_REVIEW_ID VITE_API_URL=$VITE_API_URL VITE_CONNECTED_MODE=$VITE_CONNECTED_MODE
RUN npm run build
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 5173
