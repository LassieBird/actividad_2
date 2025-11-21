# Imagen base Node
FROM node:18

# Directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar archivos de configuración
COPY package*.json ./

# Instalar dependencias
RUN npm install 

# Copiar el resto del código
COPY . .

# Exponer el puerto de la app
EXPOSE 3000

# Variable de entorno por defecto
ENV PORT=3000

# Comando de inicio
CMD ["npm", "start"]