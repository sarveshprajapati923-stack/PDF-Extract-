FROM node:20

# LibreOffice install
RUN apt-get update && apt-get install -y libreoffice

# App setup
WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
