FROM nginx:1.27-alpine

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/index.html web/styles.css web/app.js /usr/share/nginx/html/

EXPOSE 8080
